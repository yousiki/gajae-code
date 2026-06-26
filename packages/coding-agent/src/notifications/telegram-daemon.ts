import { spawn as childProcessSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import type { Settings } from "../config/settings";
import type { DaemonRuntimeInfo } from "../daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../daemon/runtime";
import { getNotificationConfig, isGloballyConfigured, tokenFingerprint } from "./config";
import { parseInThreadConfigCommand } from "./config-commands";
import { buildButtonGrid, TELEGRAM_PARSE_MODE } from "./html-format";
import type {
	SessionCloseTarget,
	SessionCreateTarget,
	SessionLifecycleRequest,
	SessionLifecycleResponse,
	SessionResumeTarget,
} from "./index";
import {
	formatLifecycleOutcome,
	isLifecycleCommandText,
	lifecycleUsage,
	parseLifecycleCommand,
	validateLifecycleTarget,
} from "./lifecycle-commands";
import {
	attachLifecycleControl,
	buildOrchestratorDeps,
	type ControlServerLike,
	createNativeControlServer,
	type LifecycleControlServer,
	type LifecycleControlServerFactory,
} from "./lifecycle-control-runtime";
import { RateLimitPool } from "./rate-limit-pool";
import { listRecentSessions } from "./recent-activity";
import {
	type AliasTable,
	buildActionMessage,
	type CallbackRoute,
	createAliasTable,
	type PendingAsk,
	readEndpoint,
	routeInboundUpdate,
} from "./telegram-reference";
import { decideThreadedInbound } from "./threaded-inbound";
import { renderThreadedFrame, type ThreadedSend } from "./threaded-render";
import { TopicRegistry, type TopicRegistryState } from "./topic-registry";

export type EnsureDaemonResult = "owner_spawned" | "attached" | "disabled";

export interface DaemonState {
	pid: number;
	ownerId: string;
	tokenFingerprint: string;
	chatId: string;
	startedAt: number;
	heartbeatAt: number;
	roots: string[];
	version: 1;
	stoppedAt?: number;
}

export interface DaemonPaths {
	dir: string;
	lock: string;
	state: string;
	roots: string;
	steal: string;
	aliases: string;
}

export interface TelegramDaemonFs {
	mkdir(path: string, opts?: fs.MakeDirectoryOptions): Promise<void>;
	readFile(path: string, encoding: BufferEncoding): Promise<string>;
	writeFile(path: string, data: string, opts?: fs.WriteFileOptions): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	open(path: string, flags: string, mode?: number): Promise<{ close(): Promise<void> }>;
	readdir(path: string): Promise<string[]>;
	chmod(path: string, mode: number): Promise<void>;
}

export interface SpawnResult {
	unref?: () => void;
}

export interface TelegramDaemonDeps {
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
	pidAlive?: (pid: number) => boolean;
	spawn?: (
		command: string,
		args: string[],
		opts: { detached: boolean; stdio: "ignore"; logPath?: string },
	) => SpawnResult;
	execPath?: string;
	randomId?: () => string;
}

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_MS = 20_000;
export const DAEMON_VERSION = 1;
/** Capability token advertised when the server supports app-level ping/pong. */
export const CLIENT_PING_PONG_CAPABILITY = "client_ping_pong";
/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 2;

const nodeFs: TelegramDaemonFs = fs.promises as unknown as TelegramDaemonFs;
const RATE_LIMIT_FLUSH_INTERVAL_MS = 1_000;
// How often the daemon rescans for newly-started sessions. This MUST run
// independently of the Telegram getUpdates long-poll (up to 25s): otherwise a
// session that starts mid-poll is not connected until the poll returns, so its
// buffered ask is delivered up to 25s late — or never, if the user answers the
// local ask first (which clears the buffered ask).
const SESSION_SCAN_INTERVAL_MS = 1_000;
// Transient Telegram API delivery is retried this many times before giving up.
const BOT_API_RETRY_ATTEMPTS = 3;
// Backoff after a failed getUpdates long-poll so a persistent outage does not
// busy-loop the daemon.
const POLL_BACKOFF_MS = 1_000;
// Telegram clears a chat action after ~5s; refresh slightly sooner to keep the
// typing indicator alive while the agent is busy.
const TYPING_REFRESH_INTERVAL_MS = 4_000;
// Native reactions used as a two-stage delivery double-check on inbound thread
// messages: queued on receipt, consumed once a turn picks the message up.
const QUEUED_REACTION = "👀";
const CONSUMED_REACTION = "✅";

/**
 * Whether `err` is a transient network failure worth retrying. Telegram API
 * calls over HTTP/2 occasionally surface mid-stream `ECONNRESET` (and similar)
 * that the global h2 fallback does not catch; treating these as fatal drops ask
 * notifications and (in the polling loop) crashes the daemon.
 */
function isTransientNetworkError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string") {
		const transient = new Set([
			"ECONNRESET",
			"ECONNREFUSED",
			"ETIMEDOUT",
			"EPIPE",
			"ENOTFOUND",
			"EAI_AGAIN",
			"UND_ERR_SOCKET",
			"ConnectionClosed",
			"ConnectionReset",
			"ConnectionRefused",
			"ConnectionTimeout",
			"FailedToOpenSocket",
		]);
		if (transient.has(code)) return true;
	}
	const message = (err as { message?: unknown } | null)?.message;
	return (
		typeof message === "string" &&
		/socket connection was closed|econnreset|fetch failed|network|timed out|terminated/i.test(message)
	);
}

/** `fetch` with bounded retries on transient network failures. */
async function fetchWithRetry(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	sleep: (ms: number) => Promise<void>,
	attempts: number = BOT_API_RETRY_ATTEMPTS,
): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fetchImpl(url, init);
		} catch (err) {
			lastErr = err;
			if (!isTransientNetworkError(err) || attempt === attempts - 1) throw err;
			await sleep(200 * 2 ** attempt);
		}
	}
	throw lastErr;
}

export function daemonPaths(agentDir: string): DaemonPaths {
	const dir = path.join(agentDir, "notifications");
	return {
		dir,
		lock: path.join(dir, "telegram-daemon.lock"),
		state: path.join(dir, "telegram-daemon.state.json"),
		roots: path.join(dir, "telegram-daemon.roots.json"),
		steal: path.join(dir, "telegram-daemon.steal"),
		aliases: path.join(dir, "telegram-callback-aliases.json"),
	};
}

/**
 * Attach session-lifecycle control (create/close/resume) to the running daemon.
 *
 * Wires an already-started, authenticated control server to the lifecycle
 * orchestrator with real daemon-side effects (tmux launcher / force-close /
 * resume), a durable fsynced idempotency ledger + audit JSONL under the agent
 * notifications dir, and strict paired-chat gating. The control server itself
 * (NotificationControlServer) is owned/started by the daemon process; this
 * function only connects it to policy. Returns the orchestrator deps for tests.
 */
export function startDaemonLifecycleControl(input: {
	controlServer: ControlServerLike;
	pairedChatId: string;
	agentDir: string;
	env?: NodeJS.ProcessEnv;
}): void {
	const deps = buildOrchestratorDeps({
		pairedChatId: input.pairedChatId,
		agentNotificationsDir: daemonPaths(input.agentDir).dir,
		env: input.env,
	});
	attachLifecycleControl(input.controlServer, deps);
}

async function ensureDir(fsImpl: TelegramDaemonFs, dir: string): Promise<void> {
	await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
	await fsImpl.chmod(dir, 0o700).catch(() => undefined);
}

async function readJson<T>(fsImpl: TelegramDaemonFs, file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fsImpl.readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJsonAtomic(fsImpl: TelegramDaemonFs, file: string, data: unknown): Promise<void> {
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await fsImpl.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
	await fsImpl.rename(tmp, file);
}

async function tryOpenWx(fsImpl: TelegramDaemonFs, file: string): Promise<boolean> {
	try {
		const handle = await fsImpl.open(file, "wx", 0o600);
		await handle.close();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

export async function registerNotificationRoot(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	fs?: TelegramDaemonFs;
}): Promise<string> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const root = path.join(input.cwd, ".gjc", "state");
	await withFileLock(
		paths.roots,
		async () => {
			const current =
				(await readJson<{ roots?: string[]; sessions?: Record<string, string> }>(fsImpl, paths.roots)) ?? {};
			const roots = new Set(current.roots ?? []);
			roots.add(root);
			await writeJsonAtomic(fsImpl, paths.roots, {
				version: 1,
				roots: Array.from(roots).sort(),
				sessions: { ...(current.sessions ?? {}), [input.sessionId]: root },
			});
		},
		{ staleMs: 10_000 },
	);
	return root;
}

export function isFreshLiveOwner(input: {
	state: DaemonState | undefined;
	now: number;
	tokenFingerprint: string;
	chatId: string;
	pidAlive: (pid: number) => boolean;
}): boolean {
	const { state } = input;
	return Boolean(
		state &&
			state.version === DAEMON_VERSION &&
			state.tokenFingerprint === input.tokenFingerprint &&
			state.chatId === input.chatId &&
			input.now - state.heartbeatAt <= HEARTBEAT_TTL_MS &&
			input.pidAlive(state.pid),
	);
}

export async function acquireDaemonOwnership(input: {
	settings: Settings;
	roots?: string[];
	tokenFingerprint: string;
	chatId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
	pidAlive?: (pid: number) => boolean;
	randomId?: () => string;
}): Promise<{ acquired: boolean; ownerId?: string; attached?: boolean }> {
	const fsImpl = input.fs ?? nodeFs;
	const now = input.now ?? Date.now;
	const pid = input.pid ?? process.pid;
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const paths = daemonPaths(input.settings.getAgentDir());
	await ensureDir(fsImpl, paths.dir);
	const ownerId = input.randomId?.() ?? `${pid}-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const roots = input.roots ?? (await readJson<{ roots?: string[] }>(fsImpl, paths.roots))?.roots ?? [];
	const existing = await readJson<DaemonState>(fsImpl, paths.state);
	if (
		isFreshLiveOwner({
			state: existing,
			now: now(),
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive,
		})
	) {
		return { acquired: false, attached: true };
	}
	if (await tryOpenWx(fsImpl, paths.lock)) {
		await writeJsonAtomic(fsImpl, paths.state, {
			pid,
			ownerId,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			startedAt: now(),
			heartbeatAt: now(),
			roots,
			version: DAEMON_VERSION,
		} satisfies DaemonState);
		return { acquired: true, ownerId };
	}
	const afterLock = await readJson<DaemonState>(fsImpl, paths.state);
	if (
		isFreshLiveOwner({
			state: afterLock,
			now: now(),
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			pidAlive,
		})
	) {
		return { acquired: false, attached: true };
	}
	if (!afterLock) return { acquired: false, attached: true };
	if (!(await tryOpenWx(fsImpl, paths.steal))) return { acquired: false, attached: true };
	try {
		const rechecked = await readJson<DaemonState>(fsImpl, paths.state);
		if (
			isFreshLiveOwner({
				state: rechecked,
				now: now(),
				tokenFingerprint: input.tokenFingerprint,
				chatId: input.chatId,
				pidAlive,
			})
		) {
			return { acquired: false, attached: true };
		}
		if (rechecked && pidAlive(rechecked.pid)) {
			return { acquired: false, attached: true };
		}
		await fsImpl.unlink(paths.lock).catch(() => undefined);
		if (!(await tryOpenWx(fsImpl, paths.lock))) return { acquired: false, attached: true };
		await writeJsonAtomic(fsImpl, paths.state, {
			pid,
			ownerId,
			tokenFingerprint: input.tokenFingerprint,
			chatId: input.chatId,
			startedAt: now(),
			heartbeatAt: now(),
			roots,
			version: DAEMON_VERSION,
		} satisfies DaemonState);
		return { acquired: true, ownerId };
	} finally {
		await fsImpl.unlink(paths.steal).catch(() => undefined);
	}
}

export async function renewDaemonHeartbeat(input: {
	settings: Settings;
	ownerId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
	pid?: number;
}): Promise<boolean> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readJson<DaemonState>(fsImpl, paths.state);
	if (!state || state.ownerId !== input.ownerId) return false;
	await writeJsonAtomic(fsImpl, paths.state, {
		...state,
		pid: input.pid ?? state.pid,
		heartbeatAt: (input.now ?? Date.now)(),
	});
	return true;
}

export async function releaseDaemonOwnership(input: {
	settings: Settings;
	ownerId: string;
	fs?: TelegramDaemonFs;
	now?: () => number;
}): Promise<void> {
	const fsImpl = input.fs ?? nodeFs;
	const paths = daemonPaths(input.settings.getAgentDir());
	const state = await readJson<DaemonState>(fsImpl, paths.state);
	if (state?.ownerId !== input.ownerId) return;
	await writeJsonAtomic(fsImpl, paths.state, { ...state, stoppedAt: (input.now ?? Date.now)() });
	await fsImpl.unlink(paths.lock).catch(() => undefined);
}

/** Read the persisted daemon ownership state (or undefined when absent). */
export async function readDaemonState(
	settings: Settings,
	fs: TelegramDaemonFs = nodeFs,
): Promise<DaemonState | undefined> {
	return readJson<DaemonState>(fs, daemonPaths(settings.getAgentDir()).state);
}

/** Read the persisted notification roots list. */
export async function readDaemonRoots(settings: Settings, fs: TelegramDaemonFs = nodeFs): Promise<string[]> {
	const roots = await readJson<{ roots?: string[] }>(fs, daemonPaths(settings.getAgentDir()).roots);
	return roots?.roots ?? [];
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** True for AbortError-shaped rejections raised when an in-flight fetch is aborted. */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || /\baborted\b/i.test(err.message));
}

function defaultDaemonSpawn(
	command: string,
	args: string[],
	opts: { detached: boolean; stdio: "ignore"; logPath?: string },
): SpawnResult {
	// Redirect the detached daemon's stdout/stderr to a log file so failures
	// (e.g. a rejected sendMessage) are diagnosable instead of vanishing.
	let stdio: "ignore" | ["ignore", number, number] = opts.stdio;
	if (opts.logPath) {
		try {
			fs.mkdirSync(path.dirname(opts.logPath), { recursive: true, mode: 0o700 });
			const fd = fs.openSync(opts.logPath, "a", 0o600);
			stdio = ["ignore", fd, fd];
		} catch {
			// Fall back to ignoring output if the log file cannot be opened.
		}
	}
	const child = childProcessSpawn(command, args, { detached: opts.detached, stdio });
	// Best-effort autostart: a spawn failure must never crash the host session.
	child.on("error", () => undefined);
	return { unref: () => child.unref() };
}

export interface TelegramSpawnOwnerInput {
	settings: Settings;
	roots?: string[];
	tokenFingerprint: string;
	chatId: string;
}

export interface TelegramSpawnOwnerResult {
	result: EnsureDaemonResult;
	ownerId?: string;
	runtime: DaemonRuntimeInfo;
	warnings: string[];
}

/**
 * Build the detached spawn command/args for the daemon-internal entrypoint.
 * Source mode prepends the entry script so the respawn loads edited source;
 * a compiled binary self-spawns its own subcommand directly.
 */
export function buildTelegramDaemonSpawnArgs(input: { execPath?: string; ownerId: string; agentDir: string }): {
	command: string;
	args: string[];
	runtime: DaemonRuntimeInfo;
} {
	const rt = resolveGjcRuntimeSpawnInfo(input.execPath ?? process.execPath);
	const args = [
		...rt.argsPrefix,
		"notify",
		"daemon-internal",
		"--owner-id",
		input.ownerId,
		"--agent-dir",
		input.agentDir,
	];
	const runtime: DaemonRuntimeInfo = {
		mode: rt.mode,
		execPath: rt.execPath,
		reloadPicksUpSourceEdits: rt.reloadPicksUpSourceEdits,
		warning: rt.warning,
	};
	return { command: rt.execPath, args, runtime };
}

/**
 * Acquire ownership for the given Telegram identity and, if acquired, spawn a
 * fresh detached daemon process. Does NOT register notification roots; callers
 * that own a session (autostart) register roots separately, while reload reuses
 * already-persisted roots.
 */
export async function spawnTelegramDaemonOwner(
	input: TelegramSpawnOwnerInput,
	deps: TelegramDaemonDeps = {},
): Promise<TelegramSpawnOwnerResult> {
	const agentDir = input.settings.getAgentDir();
	const execPath = deps.execPath ?? process.execPath;
	const ownership = await acquireDaemonOwnership({
		settings: input.settings,
		roots: input.roots,
		tokenFingerprint: input.tokenFingerprint,
		chatId: input.chatId,
		fs: deps.fs,
		now: deps.now,
		pid: deps.pid,
		pidAlive: deps.pidAlive,
		randomId: deps.randomId,
	});
	// One source of truth for runtime detection + spawn args (no duplicate resolve).
	const { command, args, runtime } = buildTelegramDaemonSpawnArgs({
		execPath,
		ownerId: ownership.ownerId ?? "",
		agentDir,
	});
	if (!ownership.acquired) return { result: "attached", runtime, warnings: [] };
	const spawnImpl = deps.spawn ?? defaultDaemonSpawn;
	const child = spawnImpl(command, args, {
		detached: true,
		stdio: "ignore",
		logPath: path.join(daemonPaths(agentDir).dir, "daemon.log"),
	});
	child?.unref?.();
	return { result: "owner_spawned", ownerId: ownership.ownerId, runtime, warnings: [] };
}

export async function ensureTelegramDaemonRunning(
	input: { settings: Settings; cwd: string; sessionId: string },
	deps: TelegramDaemonDeps = {},
): Promise<EnsureDaemonResult> {
	const cfg = getNotificationConfig(input.settings);
	if (!isGloballyConfigured(cfg) || !cfg.botToken || !cfg.chatId) return "disabled";
	const root = await registerNotificationRoot({ ...input, fs: deps.fs });
	const fp = tokenFingerprint(cfg.botToken);
	const spawned = await spawnTelegramDaemonOwner(
		{ settings: input.settings, roots: [root], tokenFingerprint: fp, chatId: cfg.chatId },
		deps,
	);
	return spawned.result;
}

export interface BotApi {
	call(method: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * Cooperative control seam for the daemon run loop. Implemented by the
 * daemon-internal CLI / controller against the owner-scoped control-request
 * file so the daemon does not import the control module directly.
 */
export interface DaemonControlHooks {
	/** Returns true when a stop/reload has been requested for this owner. */
	shouldStop(ownerId: string): Promise<boolean>;
	/** Clear a consumed control request (best-effort). */
	clear?(ownerId: string): Promise<void>;
}

export interface TelegramDaemonOptions {
	settings: Settings;
	ownerId: string;
	botToken: string;
	chatId: string;
	apiBase?: string;
	fetchImpl?: typeof fetch;
	fs?: TelegramDaemonFs;
	WebSocketImpl?: typeof WebSocket;
	now?: () => number;
	setTimeoutImpl?: typeof setTimeout;
	clearTimeoutImpl?: typeof clearTimeout;
	setIntervalImpl?: typeof setInterval;
	clearIntervalImpl?: typeof clearInterval;
	idleTimeoutMs?: number;
	scanIntervalMs?: number;
	pid?: number;
	botApi?: BotApi;
	control?: DaemonControlHooks;
	/**
	 * Factory for the session-lifecycle control server. Defaults to the real
	 * native NotificationControlServer; tests inject a fake to verify the
	 * owner-bound start/stop lifecycle without a socket. When `undefined` AND no
	 * default applies (e.g. lifecycle control disabled), no control server starts.
	 */
	createLifecycleControlServer?: LifecycleControlServerFactory | null;
}

interface SessionSocket {
	sessionId: string;
	token: string;
	ws: WebSocket;
	pending: Map<string, { sessionId: string; actionId: string }>;
	/** True once the server advertised the `client_ping_pong` capability. */
	capable: boolean;
	/** Timestamp (via opts.now) of the last received pong; seeds the TTL window. */
	lastPongAt: number;
	/** Nonce of the most recent in-flight ping, if any. */
	awaitingNonce: string | undefined;
	/** Per-session liveness interval handle (only set for capable sessions). */
	pingTimer: ReturnType<typeof setInterval> | undefined;
}

export class TelegramNotificationDaemon {
	readonly aliasTable: AliasTable;
	readonly messageRoutes = new Map<string | number, CallbackRoute | Omit<CallbackRoute, "answer">>();
	readonly sessions = new Map<string, SessionSocket>();
	private running = false;
	private offset = 0;
	private readonly fsImpl: TelegramDaemonFs;
	private readonly botApi: BotApi;
	private readonly topics = new TopicRegistry();
	private readonly pool: RateLimitPool<{ send: ThreadedSend; topicId: string }>;
	private readonly seenUpdateIds = new Set<number>();
	private flushTimer: ReturnType<typeof setInterval> | undefined;
	private scanTimer: ReturnType<typeof setInterval> | undefined;
	private scanning = false;
	private typingTimer: ReturnType<typeof setInterval> | undefined;
	/** Sessions whose agent loop is currently busy (drives the typing indicator). */
	private readonly busy = new Set<string>();
	/** Inbound update id → originating Telegram message, for delivery reactions. */
	private readonly inboundReactions = new Map<number, { messageId: number }>();
	/** AbortController for the in-flight long poll; aborted by requestStop() to wake the loop. */
	private activePoll: AbortController | undefined;
	/** Set when a cooperative stop has been requested (signal or control request). */
	private stopRequested = false;
	/** Current bounded backoff after a Telegram getUpdates 409 conflict (0 when healthy). */
	private pollConflictBackoffMs = 0;
	/**
	 * The owner-bound session-lifecycle control server (create/close/resume).
	 * Started in {@link run} after ownership is confirmed (so exactly one owner
	 * ever runs one), stopped in run()'s finally on any exit path.
	 */
	private controlServer: LifecycleControlServer | undefined;
	/** True while lifecycle control is active, so the loop keeps polling at idle. */
	private lifecycleControlActive = false;
	/** Control token (in-memory) the loopback client presents; never persisted/logged. */
	private controlToken: string | undefined;
	/** Loopback WS client to the daemon's own control endpoint (Option A real wire path). */
	private controlClient: WebSocket | undefined;
	/** Pending lifecycle responses awaiting a control-endpoint reply, by requestId. */
	private readonly pendingLifecycle = new Map<
		string,
		{ resolve: (r: SessionLifecycleResponse) => void; timer: ReturnType<typeof setTimeout> }
	>();
	/** Monotonic counter for unique lifecycle request ids. */
	private lifecycleSeq = 0;

	/**
	 * Cooperatively stop the daemon: set the stop flag and abort the in-flight
	 * long poll so the run loop wakes immediately instead of waiting out the
	 * ~25s getUpdates timeout. Safe to call from a signal handler.
	 */
	requestStop(_reason?: "reload" | "stop" | "signal"): void {
		this.stopRequested = true;
		this.running = false;
		this.activePoll?.abort();
	}

	/**
	 * Start the owner-bound lifecycle control server and wire it to the
	 * orchestrator. Called from {@link run} ONLY after ownership is confirmed, so
	 * exactly one owner ever starts exactly one control server (no second poller
	 * / 409). A control-server failure degrades gracefully: the daemon keeps
	 * serving notifications without lifecycle control. Returns true when started.
	 */
	private async startLifecycleControl(): Promise<boolean> {
		const factory =
			this.opts.createLifecycleControlServer === null
				? undefined
				: (this.opts.createLifecycleControlServer ?? createNativeControlServer);
		if (!factory) return false;
		let server: LifecycleControlServer | undefined;
		try {
			// High-entropy, in-memory control token (never persisted raw / logged).
			const token = crypto.randomBytes(32).toString("base64url");
			const agentDir = this.opts.settings.getAgentDir();
			server = factory({ token, ownerId: this.opts.ownerId, agentDir });
			const deps = buildOrchestratorDeps({
				pairedChatId: this.opts.chatId,
				agentNotificationsDir: daemonPaths(agentDir).dir,
			});
			// Register the lifecycle-request handler BEFORE start(): the native
			// control server captures the callback at start time, so wiring must
			// precede start or forwarded requests never reach the orchestrator.
			attachLifecycleControl(server, deps);
			const endpoint = (await server.start()) as { url?: string } | undefined;
			this.controlServer = server;
			this.controlToken = token;
			// Option A: connect a loopback WS client to our own control endpoint so
			// parsed /session_* commands traverse the real authenticated wire path.
			// Mark control active ONLY after the client is open, so a first-poll
			// /session_create never races a still-CONNECTING socket.
			const opened = endpoint?.url ? await this.connectControlClient(endpoint.url, token) : false;
			this.lifecycleControlActive = opened;
			if (!opened) {
				logger.warn("notifications: lifecycle control client did not open; lifecycle commands disabled");
			}
			return opened;
		} catch (e) {
			// Never let lifecycle-control startup kill the notifications daemon.
			// Stop any partially-started server so it cannot leak.
			try {
				server?.stop();
			} catch {
				// best-effort
			}
			logger.warn(`notifications: lifecycle control failed to start: ${String(e)}`);
			this.controlServer = undefined;
			this.lifecycleControlActive = false;
			return false;
		}
	}

	/** Stop the lifecycle control server (idempotent); called from run()'s finally. */
	private stopLifecycleControl(): void {
		this.lifecycleControlActive = false;
		this.controlToken = undefined;
		const client = this.controlClient;
		this.controlClient = undefined;
		try {
			client?.close();
		} catch {
			// best-effort
		}
		// Reject any in-flight lifecycle requests so callers do not hang.
		for (const [requestId, pending] of this.pendingLifecycle) {
			clearTimeout(pending.timer);
			pending.resolve({
				type: "session_lifecycle_error",
				requestId,
				status: "error",
				reason: "terminal_uncertain",
				message: "control server stopped",
			});
		}
		this.pendingLifecycle.clear();
		const server = this.controlServer;
		this.controlServer = undefined;
		try {
			server?.stop();
		} catch (e) {
			logger.warn(`notifications: lifecycle control failed to stop cleanly: ${String(e)}`);
		}
	}

	/**
	 * Connect the loopback control client and resolve responses by requestId.
	 * Resolves true once the socket is OPEN (bounded), false on error/timeout, so
	 * the caller only marks lifecycle control active when commands can be sent.
	 */
	private connectControlClient(url: string, token: string): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			let settled = false;
			const finish = (ok: boolean) => {
				if (settled) return;
				settled = true;
				resolve(ok);
			};
			try {
				const WsCtor = this.opts.WebSocketImpl ?? WebSocket;
				const client = new WsCtor(`${url}/?token=${encodeURIComponent(token)}`);
				this.controlClient = client;
				const openTimer = (this.opts.setTimeoutImpl ?? setTimeout)(() => finish(false), 5_000);
				client.addEventListener("open", () => {
					clearTimeout(openTimer);
					finish(true);
				});
				client.addEventListener("error", () => {
					clearTimeout(openTimer);
					finish(false);
				});
				client.addEventListener("message", (ev: MessageEvent) => {
					let msg: SessionLifecycleResponse;
					try {
						msg = JSON.parse(String((ev as { data: unknown }).data)) as SessionLifecycleResponse;
					} catch {
						return;
					}
					const requestId = (msg as { requestId?: string }).requestId;
					if (!requestId) return;
					const pending = this.pendingLifecycle.get(requestId);
					if (!pending) return;
					clearTimeout(pending.timer);
					this.pendingLifecycle.delete(requestId);
					pending.resolve(msg);
				});
			} catch (e) {
				logger.warn(`notifications: lifecycle control client failed to connect: ${String(e)}`);
				finish(false);
			}
		});
	}

	/** Send a lifecycle frame over the loopback client and await the response. */
	private submitLifecycleFrame(frame: SessionLifecycleRequest): Promise<SessionLifecycleResponse> {
		return new Promise<SessionLifecycleResponse>(resolve => {
			const client = this.controlClient;
			if (!client || client.readyState !== WebSocket.OPEN) {
				resolve({
					type: "session_lifecycle_error",
					requestId: frame.requestId,
					status: "error",
					reason: "terminal_uncertain",
					message: "lifecycle control unavailable",
				});
				return;
			}
			const timer = (this.opts.setTimeoutImpl ?? setTimeout)(() => {
				this.pendingLifecycle.delete(frame.requestId);
				resolve({
					type: "session_lifecycle_error",
					requestId: frame.requestId,
					status: "error",
					reason: "readiness_timeout",
					message: "lifecycle request timed out",
				});
			}, 120_000);
			this.pendingLifecycle.set(frame.requestId, { resolve, timer });
			try {
				client.send(JSON.stringify(frame));
			} catch (e) {
				clearTimeout(timer);
				this.pendingLifecycle.delete(frame.requestId);
				resolve({
					type: "session_lifecycle_error",
					requestId: frame.requestId,
					status: "error",
					reason: "terminal_uncertain",
					message: `lifecycle send failed: ${String(e)}`,
				});
			}
		});
	}

	private nextLifecycleRequestId(): string {
		return `tg-${this.opts.ownerId}-${(this.lifecycleSeq += 1)}-${crypto.randomBytes(4).toString("hex")}`;
	}

	/** Build an authenticated lifecycle frame from a parsed command + identity. */
	private buildLifecycleFrame(
		parsed:
			| { kind: "create"; target: SessionCreateTarget }
			| { kind: "close"; target: SessionCloseTarget }
			| { kind: "resume"; target: SessionResumeTarget },
		updateId: number,
	): SessionLifecycleRequest {
		const requestId = this.nextLifecycleRequestId();
		const token = this.controlToken ?? "";
		const chatId = this.opts.chatId;
		if (parsed.kind === "create") {
			return {
				type: "session_create",
				requestId,
				lifecycleRequestId: requestId,
				intendedSessionId: `s${crypto.randomBytes(6).toString("hex")}`,
				updateId,
				chatId,
				token,
				target: parsed.target,
			};
		}
		if (parsed.kind === "close") {
			return { type: "session_close", requestId, updateId, chatId, token, target: parsed.target, force: true };
		}
		return { type: "session_resume", requestId, updateId, chatId, token, target: parsed.target };
	}

	/**
	 * Handle a paired-chat /session_* command: validate (shared validator),
	 * route to the control endpoint, and reply with the outcome. Returns true
	 * when the message was a lifecycle command (so the caller stops processing).
	 */
	private async handleLifecycleCommand(
		text: string | undefined,
		updateId: number | undefined,
		threadId: number | undefined,
	): Promise<boolean> {
		if (!isLifecycleCommandText(text)) return false;
		const reply = (body: string) =>
			this.botApi
				.call("sendMessage", {
					chat_id: this.opts.chatId,
					...(threadId !== undefined ? { message_thread_id: threadId } : {}),
					text: body,
				})
				.catch(() => undefined);

		if (!this.lifecycleControlActive) {
			await reply("Session lifecycle control is not available right now.");
			return true;
		}
		if (updateId !== undefined && this.seenUpdateIds.has(updateId)) return true;
		if (updateId !== undefined) this.seenUpdateIds.add(updateId);

		const parsed = parseLifecycleCommand(text);
		if (parsed.kind === "none") return false;
		if (parsed.kind === "usage" || parsed.kind === "reject") {
			await reply(parsed.message);
			return true;
		}
		if (parsed.kind === "recent") {
			const recent = listRecentSessions({
				sessionsRoot: path.join(this.opts.settings.getAgentDir(), "sessions"),
				limit: 10,
			});
			const lines = recent.length
				? recent.map(e => `\u2022 ${e.sessionId}${e.path ? ` (${e.path})` : ""}`).join("\n")
				: "No recent sessions.";
			await reply(lines);
			return true;
		}

		// Defensive shared-validator pre-check before any effect.
		const verb =
			parsed.kind === "create" ? "session_create" : parsed.kind === "close" ? "session_close" : "session_resume";
		const valid = validateLifecycleTarget(verb, parsed.target);
		if (!valid.ok) {
			await reply(`${valid.message}\n\n${lifecycleUsage()}`);
			return true;
		}

		const frame = this.buildLifecycleFrame(parsed, updateId ?? Date.now());
		const response = await this.submitLifecycleFrame(frame);
		await reply(this.formatLifecycleResponse(response));
		return true;
	}

	/** Map a lifecycle response/error to a user-facing message (G010 surfacing). */
	private formatLifecycleResponse(r: SessionLifecycleResponse): string {
		return formatLifecycleOutcome(r);
	}

	constructor(private readonly opts: TelegramDaemonOptions) {
		this.fsImpl = opts.fs ?? nodeFs;
		this.aliasTable = createAliasTable();
		this.botApi = opts.botApi ?? {
			call: async (method, body, callOpts) => {
				const apiBase = opts.apiBase ?? "https://api.telegram.org";
				const url = `${apiBase}/bot${opts.botToken}/${method}`;
				const fetchImpl = opts.fetchImpl ?? fetch;
				const setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
				const sleep = (ms: number) => new Promise<void>(resolve => setTimeoutImpl(resolve, ms));
				// sendPhoto with base64 bytes must be a multipart upload (Telegram does
				// not accept base64 in JSON). Other methods stay JSON.
				const photoBody = body as { photo?: unknown; mime?: unknown } | null;
				if (method === "sendPhoto" && photoBody && typeof photoBody.photo === "string") {
					const b = body as {
						chat_id: unknown;
						message_thread_id?: unknown;
						photo: string;
						mime?: string;
						caption?: string;
						parse_mode?: string;
					};
					const form = new FormData();
					form.set("chat_id", String(b.chat_id));
					if (b.message_thread_id !== undefined) form.set("message_thread_id", String(b.message_thread_id));
					if (b.caption) form.set("caption", b.caption);
					if (b.parse_mode) form.set("parse_mode", String(b.parse_mode));
					form.set("photo", new Blob([Buffer.from(b.photo, "base64")], { type: b.mime ?? "image/png" }), "image");
					const res = await fetchWithRetry(
						fetchImpl,
						url,
						{ method: "POST", body: form, signal: callOpts?.signal },
						sleep,
					);
					return res.json();
				}
				const res = await fetchWithRetry(
					fetchImpl,
					url,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						signal: callOpts?.signal,
					},
					sleep,
				);
				return res.json();
			},
		};
		this.pool = new RateLimitPool<{ send: ThreadedSend; topicId: string }>({ now: opts.now });
	}

	async loadAliases(): Promise<void> {
		const raw = await readJson<unknown>(this.fsImpl, daemonPaths(this.opts.settings.getAgentDir()).aliases);
		if (raw) this.aliasTable.load(raw);
	}

	async persistAliases(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		await ensureDir(this.fsImpl, paths.dir);
		await writeJsonAtomic(this.fsImpl, paths.aliases, this.aliasTable.serialize());
	}

	async scanRoots(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		const rootState = await readJson<{ roots?: string[] }>(this.fsImpl, paths.roots);
		for (const root of rootState?.roots ?? []) {
			const dir = path.join(root, "notifications");
			let files: string[];
			try {
				files = await this.fsImpl.readdir(dir);
			} catch {
				continue;
			}
			for (const file of files.filter(item => item.endsWith(".json"))) {
				const sessionId = path.basename(file, ".json");
				if (this.sessions.has(sessionId)) continue;
				try {
					const endpoint = readEndpoint(path.join(dir, file));
					this.connectSession(sessionId, endpoint.url, endpoint.token);
				} catch {}
			}
		}
	}

	connectSession(sessionId: string, url: string, token: string): void {
		const WS = this.opts.WebSocketImpl ?? WebSocket;
		const ws = new WS(`${url}/?token=${encodeURIComponent(token)}`);
		const session: SessionSocket = {
			sessionId,
			token,
			ws,
			pending: new Map(),
			capable: false,
			lastPongAt: 0,
			awaitingNonce: undefined,
			pingTimer: undefined,
		};
		this.sessions.set(sessionId, session);
		// Bidirectional capability advertisement: announce client_ping_pong once the
		// socket is open. Sent on "open" only — a real WHATWG WebSocket cannot send
		// while CONNECTING — and liveness starts only after a capable ServerHello.
		ws.addEventListener("open", () => {
			if (session.ws.readyState === WebSocket.OPEN) {
				try {
					session.ws.send(
						JSON.stringify({
							type: "hello",
							protocolVersion: NOTIFICATION_PROTOCOL_VERSION,
							capabilities: [CLIENT_PING_PONG_CAPABILITY],
						}),
					);
				} catch {}
			}
		});
		ws.addEventListener("message", ev => {
			// Identity guard: a delayed frame from a superseded socket must not act
			// through the replacement session.
			if (this.sessions.get(sessionId) !== session) return;
			void this.handleSessionMessage(session, JSON.parse(String(ev.data))).catch(err => {
				// Surface frame-handling failures (e.g. a rejected ask sendMessage) to
				// the daemon log instead of an invisible unhandled rejection.
				console.error("notifications daemon: handleSessionMessage failed:", err);
			});
		});
		ws.addEventListener("close", () => {
			this.dropSession(session, "socket_closed");
		});
	}

	/**
	 * Start ack-based liveness for a session whose server advertised the
	 * `client_ping_pong` capability. Each interval drops the session when no pong
	 * has arrived within the TTL (the half-open case the socket never signals via
	 * `close`), otherwise sends a fresh application-level ping. The timer is bound
	 * to this exact session object.
	 */
	private startLiveness(session: SessionSocket): void {
		if (session.pingTimer) return;
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		const now = () => (this.opts.now ?? Date.now)();
		session.lastPongAt = now();
		session.pingTimer = setIntervalImpl(() => {
			if (this.sessions.get(session.sessionId) !== session) return;
			const t = now();
			if (t - session.lastPongAt >= HEARTBEAT_TTL_MS) {
				this.dropSession(session, "liveness_timeout");
				return;
			}
			if (session.ws.readyState === WebSocket.OPEN) {
				const nonce = `${session.sessionId}:${t}:${Math.random().toString(36).slice(2)}`;
				session.awaitingNonce = nonce;
				try {
					session.ws.send(JSON.stringify({ type: "ping", nonce }));
				} catch {}
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	/**
	 * Idempotent, identity-guarded session teardown. Clears the liveness timer,
	 * removes the map entry only when it still points at this exact session object
	 * (so a delayed old close cannot delete a replacement), and best-effort closes
	 * the socket. `scanRoots()` then reconnects the session.
	 */
	private dropSession(session: SessionSocket, _reason: string): void {
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		if (session.pingTimer) {
			clearIntervalImpl(session.pingTimer);
			session.pingTimer = undefined;
		}
		if (this.sessions.get(session.sessionId) === session) {
			this.sessions.delete(session.sessionId);
		}
		if (session.ws.readyState !== WebSocket.CLOSED) {
			try {
				session.ws.close();
			} catch {}
		}
	}

	private static readonly THREADED_FRAMES = new Set([
		"identity_header",
		"context_update",
		"turn_stream",
		"image_attachment",
		"config_update",
	]);

	private topicNameFor(sessionId: string, msg: { title?: unknown; repo?: unknown; branch?: unknown }): string {
		const repo = typeof msg?.repo === "string" && msg.repo ? msg.repo : undefined;
		const branch = typeof msg?.branch === "string" && msg.branch ? msg.branch : undefined;
		const title = typeof msg?.title === "string" && msg.title ? msg.title : undefined;
		// Name the topic "{repo}/{branch}" before a session title exists, then
		// "{repo}/{branch} - {title}" once it does. Fall back to the session id
		// only when no repo identity is available.
		const base = repo ? (branch ? `${repo}/${branch}` : repo) : undefined;
		if (base) return title ? `${base} - ${title}` : base;
		if (title) return title;
		return `GJC ${sessionId.slice(-6)}`;
	}

	/**
	 * Resolve (creating once via `createForumTopic`) the forum topic for a
	 * session. Threaded mode is required: on capability failure this returns
	 * `undefined` and the caller drops the send (no flat fallback).
	 */
	private async ensureTopic(sessionId: string, name: string): Promise<string | undefined> {
		const existing = this.topics.get(sessionId);
		if (existing) return existing.topicId;
		try {
			const rec = await this.topics.getOrCreateTopic(
				sessionId,
				async () => {
					const res = (await this.botApi.call("createForumTopic", {
						chat_id: this.opts.chatId,
						name,
					})) as { result?: { message_thread_id?: number } };
					const tid = res.result?.message_thread_id;
					if (tid === undefined || tid === null) throw new Error("createForumTopic: no message_thread_id");
					return String(tid);
				},
				this.opts.now,
			);
			this.topics.applyName(sessionId, name);
			await this.persistTopics();
			return rec.topicId;
		} catch {
			return undefined;
		}
	}

	private async persistTopics(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		await ensureDir(this.fsImpl, paths.dir);
		await writeJsonAtomic(this.fsImpl, path.join(paths.dir, "telegram-topics.json"), this.topics.serialize());
	}

	async loadTopics(): Promise<void> {
		const paths = daemonPaths(this.opts.settings.getAgentDir());
		const raw = await readJson<TopicRegistryState>(this.fsImpl, path.join(paths.dir, "telegram-topics.json"));
		// Restore the full serialized registry (topicId + identitySent + name) so a
		// fresh daemon after reload does not resend identity headers or lose renames.
		if (raw && typeof raw === "object") this.topics.load(raw);
	}

	/** Drain the shared rate-limit pool and deliver each granted send to its topic. */
	private async flushPool(): Promise<void> {
		for (const item of this.pool.drain()) {
			const { send, topicId } = item.payload;
			const thread = Number(topicId);
			try {
				if (send.method === "sendPhoto" && send.photoBase64) {
					// Real photo upload (the default botApi multiparts base64 -> file).
					await this.botApi.call("sendPhoto", {
						chat_id: this.opts.chatId,
						message_thread_id: thread,
						photo: send.photoBase64,
						mime: send.mime,
						caption: send.text,
						parse_mode: TELEGRAM_PARSE_MODE,
					});
				} else if (send.text) {
					await this.botApi.call("sendMessage", {
						chat_id: this.opts.chatId,
						message_thread_id: thread,
						text: send.text,
						parse_mode: TELEGRAM_PARSE_MODE,
					});
				}
			} catch {
				// Best-effort: a failed send must never stop the daemon.
			}
		}
	}

	private startFlushTimer(): void {
		if (this.flushTimer) return;
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		this.flushTimer = setIntervalImpl(() => {
			if (!this.running || this.pool.pending === 0) return;
			void this.flushPool();
		}, RATE_LIMIT_FLUSH_INTERVAL_MS);
	}

	private stopFlushTimer(): void {
		if (!this.flushTimer) return;
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		clearIntervalImpl(this.flushTimer);
		this.flushTimer = undefined;
	}

	/** Run a root scan, guarding against overlapping scans from the timer + loop. */
	private async runScan(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		try {
			await this.scanRoots();
		} finally {
			this.scanning = false;
		}
	}

	private startScanTimer(): void {
		if (this.scanTimer) return;
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		this.scanTimer = setIntervalImpl(() => {
			if (!this.running) return;
			void this.runScan();
		}, this.opts.scanIntervalMs ?? SESSION_SCAN_INTERVAL_MS);
	}

	private stopScanTimer(): void {
		if (!this.scanTimer) return;
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		clearIntervalImpl(this.scanTimer);
		this.scanTimer = undefined;
	}

	/** Send a single `typing` chat action into a busy session's topic (best-effort). */
	private async sendTyping(sessionId: string): Promise<void> {
		const topicId = this.topics.get(sessionId)?.topicId;
		if (!topicId) return;
		try {
			await this.botApi.call("sendChatAction", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(topicId),
				action: "typing",
			});
		} catch {
			// Best-effort: a failed chat action must never stop the daemon.
		}
	}

	/** Set a native reaction on an inbound thread message (best-effort). */
	private async setReaction(messageId: number, emoji: string): Promise<void> {
		try {
			await this.botApi.call("setMessageReaction", {
				chat_id: this.opts.chatId,
				message_id: messageId,
				reaction: [{ type: "emoji", emoji }],
			});
		} catch {
			// Best-effort: reactions may be disallowed in the chat; never throw.
		}
	}

	private startTypingTimer(): void {
		if (this.typingTimer) return;
		const setIntervalImpl = this.opts.setIntervalImpl ?? setInterval;
		this.typingTimer = setIntervalImpl(() => {
			if (!this.running || this.busy.size === 0) return;
			for (const sessionId of this.busy) void this.sendTyping(sessionId);
		}, TYPING_REFRESH_INTERVAL_MS);
	}

	private stopTypingTimer(): void {
		if (!this.typingTimer) return;
		const clearIntervalImpl = this.opts.clearIntervalImpl ?? clearInterval;
		clearIntervalImpl(this.typingTimer);
		this.typingTimer = undefined;
	}

	async handleSessionMessage(session: SessionSocket, msg: any): Promise<void> {
		if (msg?.type === "hello") {
			const caps = Array.isArray(msg.capabilities) ? msg.capabilities : [];
			if (caps.includes(CLIENT_PING_PONG_CAPABILITY)) {
				session.capable = true;
				this.startLiveness(session);
			}
			return;
		}
		if (msg?.type === "pong") {
			if (typeof msg.nonce === "string" && msg.nonce === session.awaitingNonce) {
				session.awaitingNonce = undefined;
				session.lastPongAt = (this.opts.now ?? Date.now)();
			}
			return;
		}
		// Live typing indicator: track busy/idle per session and push an immediate
		// chat action so "typing…" appears without waiting for the refresh tick.
		if (msg?.type === "activity") {
			if (msg.state === "busy") {
				this.busy.add(session.sessionId);
				await this.sendTyping(session.sessionId);
			} else {
				this.busy.delete(session.sessionId);
			}
			return;
		}
		// Inbound delivery double-check: flip the queued reaction to the consumed
		// reaction once the session reports a turn picked the message up.
		if (msg?.type === "inbound_ack" && typeof msg.updateId === "number") {
			const target = this.inboundReactions.get(msg.updateId);
			if (target && msg.state === "consumed") {
				this.inboundReactions.delete(msg.updateId);
				await this.setReaction(target.messageId, CONSUMED_REACTION);
			}
			return;
		}
		if (typeof msg?.type === "string" && TelegramNotificationDaemon.THREADED_FRAMES.has(msg.type)) {
			const send = renderThreadedFrame(msg);
			if (!send) return;
			const topicId = await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg));
			if (!topicId) return;
			if (send.identity) {
				// Rename the topic if the title changed (e.g. the session title was
				// auto-generated after the topic was first created). This runs on
				// every identity frame, but does NOT re-send the bulleted message.
				const name = this.topicNameFor(session.sessionId, msg);
				if (this.topics.applyName(session.sessionId, name)) {
					try {
						await this.botApi.call("editForumTopic", {
							chat_id: this.opts.chatId,
							message_thread_id: Number(topicId),
							name,
						});
					} catch {
						// Best-effort rename; never block delivery.
					}
				}
				// Send the full bulleted identity header EXACTLY ONCE per topic.
				if (this.topics.needsIdentity(session.sessionId)) {
					this.pool.submit({
						sessionId: session.sessionId,
						lane: send.lane,
						coalesceKey: send.coalesceKey,
						payload: { send, topicId },
					});
					await this.flushPool();
					this.topics.markIdentitySent(session.sessionId);
				}
				await this.persistTopics();
				return;
			}
			this.pool.submit({
				sessionId: session.sessionId,
				lane: send.lane,
				coalesceKey: send.coalesceKey,
				payload: { send, topicId },
			});
			await this.flushPool();
			return;
		}
		if (msg.type === "action_needed" && msg.id) {
			if (msg.kind === "ask") session.pending.set(msg.id, { sessionId: session.sessionId, actionId: msg.id });
			const topicId = await this.ensureTopic(session.sessionId, this.topicNameFor(session.sessionId, msg));
			if (!topicId) return;
			const rendered = buildActionMessage({
				kind: msg.kind ?? "ask",
				id: msg.id,
				question: msg.question,
				options: msg.options,
				summary: msg.summary,
			});
			const options = Array.isArray(msg.options) ? msg.options : [];
			// Daemon keyboards MUST use alias callback data (not reference encodeCallbackData).
			// Labels show one-based numbers; the stored alias answer stays zero-based.
			const inline_keyboard = buildButtonGrid(options, (i: number) =>
				this.aliasTable.put({ sessionId: session.sessionId, actionId: msg.id, answer: i }),
			);
			const result = (await this.botApi.call("sendMessage", {
				chat_id: this.opts.chatId,
				message_thread_id: Number(topicId),
				text: rendered.text,
				parse_mode: TELEGRAM_PARSE_MODE,
				...(inline_keyboard.length ? { reply_markup: { inline_keyboard } } : {}),
			})) as { result?: { message_id?: number } };
			const messageId = result.result?.message_id;
			if (messageId !== undefined)
				this.messageRoutes.set(String(messageId), { sessionId: session.sessionId, actionId: msg.id });
			await this.persistAliases();
		} else if (msg.type === "action_resolved" && msg.id) {
			session.pending.delete(msg.id);
			for (const [alias, route] of this.aliasTable.entries()) {
				if (route.sessionId === session.sessionId && route.actionId === msg.id) this.aliasTable.delete(alias);
			}
			await this.persistAliases();
		}
	}

	pendingBySession = (sessionId?: string): PendingAsk[] => {
		const result: PendingAsk[] = [];
		for (const session of this.sessions.values()) {
			if (sessionId && session.sessionId !== sessionId) continue;
			result.push(...session.pending.values());
		}
		return result;
	};

	private async sendStaleGuidance(callbackId: unknown): Promise<void> {
		if (typeof callbackId === "string") {
			await this.botApi.call("answerCallbackQuery", { callback_query_id: callbackId, text: "Button is stale" });
		}
		await this.botApi.call("sendMessage", {
			chat_id: this.opts.chatId,
			text: "This button is stale after notification daemon restart. Please answer locally in the GJC session or wait for a fresh notification.",
			parse_mode: TELEGRAM_PARSE_MODE,
		});
	}

	async handleTelegramUpdate(update: unknown): Promise<void> {
		// Session-lifecycle command (/session_*): handled ONLY from the paired chat,
		// gated before any arg parsing or side effect, and routed through the control
		// endpoint. Must run before threaded-injection so commands are not treated as
		// session input.
		{
			const m = (update as { update_id?: number; message?: Record<string, unknown> }).message;
			const chatId = (m?.chat as { id?: unknown } | undefined)?.id;
			const cmdText = typeof m?.text === "string" ? m.text : undefined;
			if (m !== undefined && String(chatId) === String(this.opts.chatId) && isLifecycleCommandText(cmdText)) {
				const updateId = (update as { update_id?: number }).update_id;
				const threadId = typeof m.message_thread_id === "number" ? (m.message_thread_id as number) : undefined;
				if (await this.handleLifecycleCommand(cmdText, updateId, threadId)) return;
			}
		}
		// Threaded injection: a free-text message in a known topic (not a button
		// tap and not a reply to a specific ask message) injects a user turn or an
		// in-thread config command. Fail-closed: paired chat + known topic +
		// update_id dedupe are all enforced by decideThreadedInbound.
		const raw = update as {
			callback_query?: unknown;
			message?: { reply_to_message?: { message_id?: unknown } };
		};
		// A reply to a known ask message routes to that ask (below). Any OTHER
		// message in a topic (plain text, or a reply to a non-ask message) is a
		// free-text injection. Previously replies bypassed injection entirely.
		const replyTo = raw.message?.reply_to_message?.message_id;
		const isAskReply =
			replyTo !== undefined && (this.messageRoutes.has(String(replyTo)) || this.messageRoutes.has(Number(replyTo)));
		if (!raw.callback_query && !isAskReply) {
			const inbound = decideThreadedInbound(update as never, {
				pairedChatId: this.opts.chatId,
				topicToSession: t => this.topics.sessionForTopic(t),
				isDuplicate: id => this.seenUpdateIds.has(id),
			});
			if (inbound.kind === "duplicate") return;
			if (inbound.kind === "inject") {
				this.seenUpdateIds.add(inbound.updateId);
				const session = this.sessions.get(inbound.sessionId);
				if (session?.ws.readyState === WebSocket.OPEN) {
					const cfg = parseInThreadConfigCommand(inbound.text);
					// A plain (non-config) message while an ask is pending for this session
					// answers that ask as free-input — instead of starting a new user turn.
					// Telegram asks always accept custom text (the SDK maps a string answer
					// to the ask's custom-input slot), so route the latest pending ask here.
					const pendingAsk = cfg ? undefined : [...session.pending.values()].at(-1);
					if (pendingAsk) {
						session.ws.send(
							JSON.stringify({
								type: "reply",
								id: pendingAsk.actionId,
								answer: inbound.text,
								token: session.token,
							}),
						);
						if (inbound.messageId !== undefined) await this.setReaction(inbound.messageId, QUEUED_REACTION);
						return;
					}
					session.ws.send(
						JSON.stringify(
							cfg
								? { type: "config_command", sessionId: inbound.sessionId, token: session.token, ...cfg }
								: {
										type: "user_message",
										sessionId: inbound.sessionId,
										text: inbound.text,
										token: session.token,
										updateId: inbound.updateId,
										threadId: inbound.threadId,
									},
						),
					);
					// User turns get a native delivery double-check: queued on receipt,
					// flipped to consumed when the session acks the turn that picks it
					// up. Config commands are not user turns and get no reaction.
					if (!cfg && inbound.messageId !== undefined) {
						this.inboundReactions.set(inbound.updateId, { messageId: inbound.messageId });
						await this.setReaction(inbound.messageId, QUEUED_REACTION);
					}
				}
				return;
			}
		}
		const callbackId = (update as { callback_query?: { id?: unknown } }).callback_query?.id;
		const decision = routeInboundUpdate(update, {
			aliasTable: this.aliasTable,
			messageRoutes: this.messageRoutes,
			pendingBySession: this.pendingBySession,
			pairedChatId: this.opts.chatId,
		});
		if (decision.kind === "reply") {
			const session = this.sessions.get(decision.sessionId);
			if (session?.ws.readyState !== WebSocket.OPEN || !session.pending.has(decision.actionId)) {
				await this.sendStaleGuidance(callbackId);
				return;
			}
			if (typeof callbackId === "string")
				await this.botApi.call("answerCallbackQuery", { callback_query_id: callbackId });
			session.ws.send(
				JSON.stringify({ type: "reply", id: decision.actionId, answer: decision.answer, token: session.token }),
			);
		} else if (decision.kind === "stale") {
			await this.sendStaleGuidance(callbackId);
		}
	}

	async pollOnce(signal?: AbortSignal): Promise<number> {
		let body: {
			ok?: boolean;
			error_code?: number;
			description?: string;
			result?: Array<{ update_id: number } & Record<string, unknown>>;
		};
		try {
			body = (await this.botApi.call(
				"getUpdates",
				{ offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
				{ signal },
			)) as typeof body;
		} catch (err) {
			// A cooperative stop aborts the in-flight long poll; treat as a clean wake.
			if (isAbortError(err)) return 0;
			// A transient Telegram API failure (e.g. ECONNRESET on the long-poll) must
			// never crash the daemon — that silently stops all delivery, including ask
			// notifications. Log, back off, and let the run loop retry.
			console.error("notifications daemon: getUpdates failed:", err);
			await this.sleep(POLL_BACKOFF_MS, signal);
			return 0;
		}
		// Telegram allows only one active getUpdates poller per bot. A 409 means
		// another poller is live; back off boundedly instead of hot-looping.
		if (body && body.ok === false && (body.error_code === 409 || /409|conflict/i.test(body.description ?? ""))) {
			this.pollConflictBackoffMs = Math.min(
				this.pollConflictBackoffMs ? this.pollConflictBackoffMs * 2 : 500,
				5_000,
			);
			console.error(
				`notifications daemon: Telegram getUpdates 409 conflict (${body.description ?? "no description"}); backing off ${this.pollConflictBackoffMs}ms`,
			);
			await this.sleep(this.pollConflictBackoffMs, signal);
			return 0;
		}
		this.pollConflictBackoffMs = 0;
		for (const update of body.result ?? []) {
			this.offset = update.update_id + 1;
			try {
				await this.handleTelegramUpdate(update);
			} catch (err) {
				console.error("notifications daemon: handleTelegramUpdate failed:", err);
			}
		}
		return body.result?.length ?? 0;
	}

	/** Abortable sleep honoring the injected timer; resolves early on abort. */
	private sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>(resolve => {
			if (signal?.aborted) return resolve();
			const timer = (this.opts.setTimeoutImpl ?? setTimeout)(() => resolve(), ms);
			signal?.addEventListener(
				"abort",
				() => {
					(this.opts.clearTimeoutImpl ?? clearTimeout)(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}

	/** Sync the bot's Telegram command menu to what the daemon actually handles. */
	async registerBotCommands(): Promise<void> {
		try {
			await this.botApi.call("setMyCommands", {
				commands: [
					{ command: "verbose", description: "Mirror full tool output + reasoning in this thread" },
					{ command: "lean", description: "Mirror assistant text + tool names only (default)" },
					{ command: "redact", description: "Toggle redaction of streamed content: /redact <on|off>" },
				],
			});
		} catch {
			// Best-effort: a failed command-menu sync must never stop the daemon.
		}
	}

	async run(): Promise<void> {
		this.running = await renewDaemonHeartbeat({
			settings: this.opts.settings,
			ownerId: this.opts.ownerId,
			fs: this.fsImpl,
			now: this.opts.now,
			pid: this.opts.pid ?? process.pid,
		});
		if (!this.running) return;
		this.startFlushTimer();
		this.startScanTimer();
		this.startTypingTimer();
		try {
			await this.registerBotCommands();
			await this.loadAliases();
			await this.loadTopics();
			await this.runScan();
			// Owner-only: start the session-lifecycle control server now that
			// ownership is confirmed (singleton-safe). Best-effort; degrades.
			await this.startLifecycleControl();
			let idleSince = (this.opts.now ?? Date.now)();
			let pollBackoffMs = 0;
			while (this.running) {
				if (await this.controlStopRequested()) break;
				if (
					!(await renewDaemonHeartbeat({
						settings: this.opts.settings,
						ownerId: this.opts.ownerId,
						fs: this.fsImpl,
						now: this.opts.now,
						pid: this.opts.pid ?? process.pid,
					}))
				)
					break;
				await this.runScan();
				if (await this.controlStopRequested()) break;
				const idleElapsed = (this.opts.now ?? Date.now)() - idleSince >= (this.opts.idleTimeoutMs ?? 60_000);
				if (this.sessions.size === 0 && !this.lifecycleControlActive) {
					// No sessions and no lifecycle control: idle-exit on timeout.
					if (idleElapsed) break;
				} else {
					// Poll getUpdates when sessions exist OR lifecycle control is active
					// (so phone /session_* commands are received even with zero sessions).
					// With zero sessions, still idle-exit after the timeout so the owner
					// does not run forever; an active session resets the idle window.
					if (this.sessions.size > 0) idleSince = (this.opts.now ?? Date.now)();
					else if (idleElapsed) break;
					this.activePoll = new AbortController();
					try {
						await this.pollOnce(this.activePoll.signal);
						pollBackoffMs = 0;
					} catch (e) {
						// A transient getUpdates/network failure must not kill the
						// daemon. Back off (bounded, below the heartbeat TTL) and keep
						// renewing ownership at the loop top.
						pollBackoffMs = pollBackoffMs === 0 ? 250 : Math.min(pollBackoffMs * 2, 4_000);
						logger.warn(`notifications: getUpdates failed, backing off ${pollBackoffMs}ms: ${String(e)}`);
						await new Promise(resolve => (this.opts.setTimeoutImpl ?? setTimeout)(resolve, pollBackoffMs));
						continue;
					} finally {
						this.activePoll = undefined;
					}
				}
				if (await this.controlStopRequested()) break;
				await new Promise(resolve => (this.opts.setTimeoutImpl ?? setTimeout)(resolve, 10));
			}
		} finally {
			this.stopFlushTimer();
			this.stopScanTimer();
			this.stopTypingTimer();
			this.stopLifecycleControl();
			// Persist durable state before releasing ownership so a fresh daemon
			// (e.g. after reload) reloads aliases/topics seamlessly.
			await this.persistAliases().catch(() => undefined);
			await this.persistTopics().catch(() => undefined);
			await this.opts.control?.clear?.(this.opts.ownerId).catch(() => undefined);
			await releaseDaemonOwnership({
				settings: this.opts.settings,
				ownerId: this.opts.ownerId,
				fs: this.fsImpl,
				now: this.opts.now,
			});
		}
	}

	/** True when a signal-driven stop or an owner-scoped control request asks the loop to exit. */
	private async controlStopRequested(): Promise<boolean> {
		if (this.stopRequested) return true;
		if (!this.opts.control) return false;
		try {
			return await this.opts.control.shouldStop(this.opts.ownerId);
		} catch {
			return false;
		}
	}
}
