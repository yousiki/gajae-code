import * as crypto from "node:crypto";

import type { GcContext, GcRecord, GcStoreAdapter } from "../gc-runtime";
import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxProfileCommands,
	resolveGjcTmuxCommand,
} from "../tmux-common";
import { tmuxSessionsGcAdapter } from "../tmux-gc";
import {
	attachGjcTmuxSession,
	findGjcTmuxSessionByName,
	forceCloseGjcTmuxSession,
	type GjcTmuxSessionStatus,
	listGjcTmuxSessions,
	removeGjcTmuxSession,
	statusGjcTmuxSession,
} from "../tmux-sessions";
import type {
	GjcMuxCapabilityServices,
	GjcMuxGcCandidate,
	GjcMuxLaunchRequest,
	GjcMuxLaunchResult,
	GjcMuxOwnedPaneRef,
	GjcMuxOwnedSessionRef,
	GjcMuxOwnershipProof,
	GjcMuxSessionSnapshot,
	GjcMuxTailChunk,
	GjcMuxTailRequest,
	GjcMuxVersionProof,
} from "./types";

interface GjcTmuxAdapterInvocationResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

type GjcTmuxAdapterInvoker = (
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
) => Promise<GjcTmuxAdapterInvocationResult> | GjcTmuxAdapterInvocationResult;

interface GjcTmuxMuxServicesOptions {
	env?: NodeJS.ProcessEnv;
	invokeTmux?: GjcTmuxAdapterInvoker;
	gcAdapter?: GcStoreAdapter;
	cwd?: string;
}

function defaultInvokeTmux(argv: readonly string[], env: NodeJS.ProcessEnv): GjcTmuxAdapterInvocationResult {
	const tmux = resolveGjcTmuxCommand(env);
	const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
	const result = Bun.spawnSync([tmux, ...argv], { stdout: "pipe", stderr: "pipe", env: mergedEnv });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function redactedTmuxArgv(argv: readonly string[]): string {
	const redacted = [...argv];
	for (let index = 0; index < redacted.length - 1; index++) {
		const arg = redacted[index];
		if (arg === "--" || (arg === "-c" && argv[index - 1] === "sh")) {
			redacted[index + 1] = "<redacted>";
		}
	}
	if (redacted[0] === "send-keys" && redacted.includes("-l") && redacted.length > 0) {
		redacted[redacted.length - 1] = "<redacted>";
	}
	return redacted.join(" ");
}

function splitTmuxCaptureLines(stdout: string, lines: number): string[] {
	const withoutTerminator = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (withoutTerminator.length === 0) return [];
	return withoutTerminator.split("\n").slice(-lines);
}

async function invokeChecked(
	invokeTmux: GjcTmuxAdapterInvoker,
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<GjcTmuxAdapterInvocationResult> {
	const result = await invokeTmux(argv, env);
	if (result.exitCode === 0) return result;
	throw new Error(result.stderr.trim() || `tmux ${redactedTmuxArgv(argv)} failed`);
}

function tmuxLifecycleSessionName(sessionId: string): string {
	return `gjc_lc_${sessionId}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function versionProof(session: GjcTmuxSessionStatus): GjcMuxVersionProof {
	return {
		schemaVersion: 1,
		contractVersion: "tmux-gjc-options-v1",
		backendVersion: session.version,
		proofKind: "tmux-options",
		proofData: [
			"@gjc-profile=1",
			...(session.project ? [`@gjc-project=${session.project}`] : []),
			...(session.sessionId ? [`@gjc-session-id=${session.sessionId}`] : []),
			...(session.sessionStateFile ? [`@gjc-session-state-file=${session.sessionStateFile}`] : []),
			...(session.version ? [`@gjc-version=${session.version}`] : []),
		],
	};
}

function ownershipProof(session: GjcTmuxSessionStatus): GjcMuxOwnershipProof {
	const providerIds = { backendSessionId: session.name };
	return {
		backend: "tmux",
		gjcSessionId: session.sessionId ?? session.name,
		sessionStateFile: session.sessionStateFile ?? "",
		project: session.project ?? "",
		cwd: session.project ?? "",
		providerIds,
		version: versionProof(session),
		validatedAt: new Date().toISOString(),
	};
}

function sessionRef(session: GjcTmuxSessionStatus): GjcMuxOwnedSessionRef {
	const ownership = ownershipProof(session);
	return {
		backend: "tmux",
		gjcSessionId: ownership.gjcSessionId,
		sessionStateFile: ownership.sessionStateFile,
		project: ownership.project,
		cwd: ownership.cwd,
		providerIds: ownership.providerIds,
		ownership,
	};
}

function snapshot(session: GjcTmuxSessionStatus): GjcMuxSessionSnapshot {
	return {
		session: sessionRef(session),
		attached: session.attached,
		windows: session.windows,
		panes: session.panes,
		createdAt: session.createdAt,
	};
}

function paneTarget(pane: GjcMuxOwnedPaneRef): string {
	if (pane.backend !== "tmux") throw new Error(`unsupported_mux_backend:${pane.backend}`);
	return pane.providerIds.backendPaneId;
}

function sessionName(session: GjcMuxOwnedSessionRef): string {
	if (session.backend !== "tmux") throw new Error(`unsupported_mux_backend:${session.backend}`);
	return session.providerIds.backendSessionId;
}

function gcContext(env: NodeJS.ProcessEnv, cwd: string): GcContext {
	return {
		env,
		cwd,
		force: false,
		probe: () => ({ status: "keep", reason: "unknown" }),
	};
}

function gcCandidate(record: GcRecord): GjcMuxGcCandidate {
	const status: GjcTmuxSessionStatus = {
		name: record.id,
		attached: false,
		windows: 0,
		panes: 0,
		bindings: "",
		createdAt: "",
		project: record.path,
		panePids: [],
	};
	return {
		session: sessionRef(status),
		stale: record.stale,
		removable: record.removable,
		reason: record.reason,
	};
}

function recordFromCandidate(candidate: GjcMuxGcCandidate): GcRecord {
	return {
		store: "tmux_sessions",
		id: candidate.session.providerIds.backendSessionId,
		path: candidate.session.project || undefined,
		root: candidate.session.project || undefined,
		pid_status: "none",
		status: candidate.stale ? "stale" : "unclassified",
		stale: candidate.stale,
		removable: candidate.removable,
		action: "none",
		reason: candidate.reason,
	};
}

export function createGjcTmuxMuxCapabilityServices(options: GjcTmuxMuxServicesOptions = {}): GjcMuxCapabilityServices {
	const env = options.env ?? process.env;
	const invokeTmux = options.invokeTmux ?? defaultInvokeTmux;
	const gcAdapter = options.gcAdapter ?? tmuxSessionsGcAdapter;
	const cwd = options.cwd ?? process.cwd();
	const collectedRecords = new WeakMap<GjcMuxGcCandidate, GcRecord>();

	async function create(request: GjcMuxLaunchRequest): Promise<GjcMuxLaunchResult> {
		if (request.visible) throw new Error("unsupported_tmux_lifecycle_visible_mode");
		if (request.command.length === 0) throw new Error("unsupported_tmux_lifecycle_empty_command");
		const mergedEnv: NodeJS.ProcessEnv = { ...env, ...request.env };
		const name = tmuxLifecycleSessionName(request.gjcSessionId);
		const command = `cd ${shellQuote(request.cwd)} && exec env GJC_TMUX_LAUNCHED=1 GJC_SESSION_ID=${shellQuote(
			request.gjcSessionId,
		)} ${request.command.map(shellQuote).join(" ")}`;
		await invokeChecked(invokeTmux, ["new-session", "-d", "-s", name, "sh", "-c", command], mergedEnv);
		const tmuxCommand = resolveGjcTmuxCommand(mergedEnv);
		const target = buildGjcTmuxExactOptionTarget(name, { env: mergedEnv });
		try {
			for (const profileCommand of buildGjcTmuxProfileCommands(
				target,
				mergedEnv,
				{
					project: request.project,
					sessionId: request.gjcSessionId,
					sessionStateFile: request.sessionStateFile,
				},
				{ tmuxCommand },
			)) {
				await invokeChecked(invokeTmux, profileCommand.args, mergedEnv);
			}
		} catch (error) {
			await invokeTmux(["kill-session", "-t", buildGjcTmuxExactSessionTarget(name, { env: mergedEnv })], mergedEnv);
			throw error;
		}
		return { session: sessionRef(statusGjcTmuxSession(name, mergedEnv)) };
	}

	return {
		resolver: {
			resolveBackend: () => "tmux",
			resolveBackendCommand: resolverEnv => resolveGjcTmuxCommand(resolverEnv),
		},
		launch: { launch: create },
		sessionReader: {
			async listSessions(project) {
				return listGjcTmuxSessions(env)
					.filter(session => !project || session.project === project)
					.map(snapshot);
			},
			async getSession(session) {
				try {
					return snapshot(statusGjcTmuxSession(sessionName(session), env));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.startsWith("gjc_tmux_session_not_found:")) return undefined;
					throw error;
				}
			},
		},
		sessionMutator: {
			async attachSession(session) {
				attachGjcTmuxSession(sessionName(session), env);
			},
			async closeSession(session) {
				return snapshot(removeGjcTmuxSession(sessionName(session), env));
			},
		},
		paneMutator: {
			async focusPane(pane) {
				await invokeChecked(invokeTmux, ["select-pane", "-t", paneTarget(pane)], env);
			},
			async sendText(pane, text) {
				await invokeChecked(invokeTmux, ["send-keys", "-l", "-t", paneTarget(pane), text], env);
			},
		},
		tailReader: {
			async readTail(request: GjcMuxTailRequest): Promise<GjcMuxTailChunk> {
				const result = await invokeChecked(
					invokeTmux,
					["capture-pane", "-p", "-t", paneTarget(request.pane), "-S", `-${request.lines}`],
					env,
				);
				const lines = splitTmuxCaptureLines(result.stdout, request.lines);
				return { pane: request.pane, lines, truncated: false };
			},
		},
		coordinatorDelivery: {
			async deliver(request) {
				const target = paneTarget(request.pane);
				const bufferName = `gjc-coordinator-prompt-${crypto.randomUUID()}`;
				await invokeChecked(invokeTmux, ["set-buffer", "-b", bufferName, "--", request.message], env);
				try {
					await invokeChecked(invokeTmux, ["paste-buffer", "-d", "-b", bufferName, "-t", target], env);
				} catch (error) {
					await invokeChecked(invokeTmux, ["delete-buffer", "-b", bufferName], env);
					throw error;
				}
				await invokeChecked(invokeTmux, ["send-keys", "-t", target, "Escape"], env);
				await invokeChecked(invokeTmux, ["send-keys", "-t", target, "Enter"], env);
				return { delivered: true };
			},
		},
		lifecycle: {
			create,
			async resume(session) {
				const current = statusGjcTmuxSession(sessionName(session), env);
				return sessionRef(current);
			},
			async close(session) {
				forceCloseGjcTmuxSession(
					sessionName(session),
					env,
					session.gjcSessionId,
					session.sessionStateFile || undefined,
				);
				return findGjcTmuxSessionByName(sessionName(session), env) === undefined;
			},
		},
		gc: {
			async collect(project) {
				const result = await gcAdapter.collect(gcContext(env, project ?? cwd));
				if (result.errors.length > 0) {
					throw new Error(result.errors.map(error => `${error.scope}:${error.message}`).join("; "));
				}
				return result.records.map(record => {
					const candidate = gcCandidate(record);
					collectedRecords.set(candidate, record);
					return candidate;
				});
			},
			async prune(candidate) {
				const record = collectedRecords.get(candidate) ?? recordFromCandidate(candidate);
				const result = await gcAdapter.prune(record, gcContext(env, candidate.session.project || cwd));
				return result.removed;
			},
		},
	};
}
export const createTmuxMuxCapabilityServices = createGjcTmuxMuxCapabilityServices;
