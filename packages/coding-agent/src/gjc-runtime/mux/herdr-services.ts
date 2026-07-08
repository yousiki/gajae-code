import { resolveGjcTmuxCommand } from "../tmux-common";
import { createGjcTmuxMuxCapabilityServices } from "./tmux-services";
import {
	GJC_HERDR_COMMAND_ENV,
	GJC_MUX_BACKEND_ENV,
	type GjcMuxBackendKind,
	type GjcMuxCapabilityServices,
	type GjcMuxGcCandidate,
	type GjcMuxLaunchRequest,
	type GjcMuxLaunchResult,
	type GjcMuxOwnedPaneRef,
	type GjcMuxOwnedSessionRef,
	type GjcMuxOwnershipProof,
	type GjcMuxSessionSnapshot,
	type GjcMuxTailChunk,
	type GjcMuxTailRequest,
	type GjcMuxVersionProof,
} from "./types";

export interface GjcHerdrAdapterInvocationResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export type GjcHerdrAdapterInvoker = (
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
) => Promise<GjcHerdrAdapterInvocationResult> | GjcHerdrAdapterInvocationResult;

export interface GjcHerdrMuxServicesOptions {
	env?: NodeJS.ProcessEnv;
	invokeHerdr?: GjcHerdrAdapterInvoker;
}

interface GjcHerdrApiSchema {
	schemaVersion: 1;
	protocol: "herdr-gjc-mux-v1";
	commands: {
		launch: readonly string[];
		status: readonly string[];
		tail: readonly string[];
		list: readonly string[];
	};
}

interface GjcHerdrIdentity {
	backendSessionId: string;
	socketPath: string;
	backendWorkspaceId: string;
	backendTabId: string;
	backendPaneId: string;
	createdAt: string;
}

interface GjcHerdrProbe {
	version: string;
	schema: GjcHerdrApiSchema;
}

function defaultInvokeHerdr(argv: readonly string[], env: NodeJS.ProcessEnv): GjcHerdrAdapterInvocationResult {
	const herdr = resolveGjcHerdrCommand(env);
	const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
	const result = Bun.spawnSync([herdr, ...argv], { stdout: "pipe", stderr: "pipe", env: mergedEnv });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

export function resolveGjcMuxBackend(env: NodeJS.ProcessEnv): GjcMuxBackendKind {
	const raw = env[GJC_MUX_BACKEND_ENV];
	const value = raw?.trim();
	if (!value || value.toLowerCase() === "tmux") return "tmux";
	if (value.toLowerCase() === "herdr") return "herdr";
	throw new Error(`unsupported_mux_backend:${raw}`);
}

export function resolveGjcHerdrCommand(env: NodeJS.ProcessEnv): string {
	const value = env[GJC_HERDR_COMMAND_ENV]?.trim();
	return value && value.length > 0 ? value : "herdr";
}

export function resolveGjcMuxBackendCommand(env: NodeJS.ProcessEnv): string {
	return resolveGjcMuxBackend(env) === "herdr" ? resolveGjcHerdrCommand(env) : resolveGjcTmuxCommand(env);
}

function mergedEnv(baseEnv: NodeJS.ProcessEnv, overrideEnv: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
	return { ...process.env, ...baseEnv, ...overrideEnv };
}

function redactedHerdrArgv(argv: readonly string[]): string {
	const separator = argv.indexOf("--");
	return (separator === -1 ? [...argv] : [...argv.slice(0, separator + 1), "<redacted>"]).join(" ");
}

async function invokeChecked(
	invokeHerdr: GjcHerdrAdapterInvoker,
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	failurePrefix = "herdr_unavailable",
): Promise<GjcHerdrAdapterInvocationResult> {
	let result: GjcHerdrAdapterInvocationResult;
	try {
		result = await invokeHerdr(argv, env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${failurePrefix}:${message}`);
	}
	if (result.exitCode === 0) return result;
	throw new Error(`${failurePrefix}:${result.stderr.trim() || redactedHerdrArgv(argv)}`);
}

function assertStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.length > 0);
}

function parseSchema(stdout: string): GjcHerdrApiSchema {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`herdr_schema_parse_failed:${message}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("unsupported_herdr_api_schema:not_object");
	const record = parsed as Record<string, unknown>;
	const commands = record.commands;
	if (record.schemaVersion !== 1)
		throw new Error(`unsupported_herdr_api_schema:schemaVersion:${String(record.schemaVersion)}`);
	if (record.protocol !== "herdr-gjc-mux-v1")
		throw new Error(`unsupported_herdr_api_schema:protocol:${String(record.protocol)}`);
	if (typeof commands !== "object" || commands === null) throw new Error("unsupported_herdr_api_schema:commands");
	const commandRecord = commands as Record<string, unknown>;
	if (!assertStringArray(commandRecord.launch)) throw new Error("unsupported_herdr_api_schema:commands.launch");
	if (!assertStringArray(commandRecord.status)) throw new Error("unsupported_herdr_api_schema:commands.status");
	if (!assertStringArray(commandRecord.tail)) throw new Error("unsupported_herdr_api_schema:commands.tail");
	if (!assertStringArray(commandRecord.list)) throw new Error("unsupported_herdr_api_schema:commands.list");
	return {
		schemaVersion: 1,
		protocol: "herdr-gjc-mux-v1",
		commands: {
			launch: commandRecord.launch,
			status: commandRecord.status,
			tail: commandRecord.tail,
			list: commandRecord.list,
		},
	};
}

async function probeHerdr(invokeHerdr: GjcHerdrAdapterInvoker, env: NodeJS.ProcessEnv): Promise<GjcHerdrProbe> {
	const versionResult = await invokeChecked(invokeHerdr, ["--version"], env);
	const schemaResult = await invokeChecked(invokeHerdr, ["api", "schema", "--json"], env);
	return { version: versionResult.stdout.trim(), schema: parseSchema(schemaResult.stdout) };
}

function generatedSessionName(gjcSessionId: string): string {
	const safe = gjcSessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
	return `gjc_${safe}`;
}

function stringField(record: Record<string, unknown>, camel: string, snake = camel): string | undefined {
	const value = record[camel] ?? record[snake];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identityFromRecord(record: Record<string, unknown>): GjcHerdrIdentity {
	const socketPath = stringField(record, "socketPath", "socket_path") ?? stringField(record, "endpoint");
	const identity = {
		backendSessionId:
			stringField(record, "sessionId", "session_id") ?? stringField(record, "sessionName", "session_name"),
		socketPath,
		backendWorkspaceId: stringField(record, "workspaceId", "workspace_id"),
		backendTabId: stringField(record, "tabId", "tab_id"),
		backendPaneId: stringField(record, "paneId", "pane_id"),
		createdAt: stringField(record, "createdAt", "created_at"),
	};
	for (const [field, value] of Object.entries(identity)) {
		if (!value) throw new Error(`herdr_identity_missing:${field}`);
	}
	return identity as GjcHerdrIdentity;
}

function parseIdentity(stdout: string): GjcHerdrIdentity {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`herdr_identity_parse_failed:${message}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("herdr_identity_parse_failed:not_object");
	return identityFromRecord(parsed as Record<string, unknown>);
}

function parseIdentityList(stdout: string): readonly GjcHerdrIdentity[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`herdr_list_parse_failed:${message}`);
	}
	const sessions = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).sessions)
			? ((parsed as Record<string, unknown>).sessions as unknown[])
			: undefined;
	if (!sessions) throw new Error("herdr_list_parse_failed:sessions");
	return sessions.map((session, index) => {
		if (typeof session !== "object" || session === null) throw new Error(`herdr_list_parse_failed:session:${index}`);
		return identityFromRecord(session as Record<string, unknown>);
	});
}

function versionProof(probe: GjcHerdrProbe, identity: GjcHerdrIdentity): GjcMuxVersionProof {
	return {
		schemaVersion: probe.schema.schemaVersion,
		contractVersion: probe.schema.protocol,
		backendVersion: probe.version,
		proofKind: "herdr-metadata",
		proofData: [
			`schemaVersion=${probe.schema.schemaVersion}`,
			`protocol=${probe.schema.protocol}`,
			`session=${identity.backendSessionId}`,
			`socket=${identity.socketPath}`,
			`workspace=${identity.backendWorkspaceId}`,
			`tab=${identity.backendTabId}`,
			`pane=${identity.backendPaneId}`,
		],
	};
}

function ownershipProof(
	request: Pick<GjcMuxLaunchRequest, "cwd" | "project" | "gjcSessionId" | "sessionStateFile">,
	probe: GjcHerdrProbe,
	identity: GjcHerdrIdentity,
): GjcMuxOwnershipProof {
	return {
		backend: "herdr",
		gjcSessionId: request.gjcSessionId,
		sessionStateFile: request.sessionStateFile,
		project: request.project,
		cwd: request.cwd,
		providerIds: {
			backendSessionId: identity.backendSessionId,
			backendPaneId: identity.backendPaneId,
			backendWorkspaceId: identity.backendWorkspaceId,
			backendTabId: identity.backendTabId,
			socketPath: identity.socketPath,
		},
		version: versionProof(probe, identity),
		validatedAt: new Date().toISOString(),
	};
}

function refsFromIdentity(
	request: Pick<GjcMuxLaunchRequest, "cwd" | "project" | "gjcSessionId" | "sessionStateFile">,
	probe: GjcHerdrProbe,
	identity: GjcHerdrIdentity,
): GjcMuxLaunchResult {
	const ownership = ownershipProof(request, probe, identity);
	const session: GjcMuxOwnedSessionRef = {
		backend: "herdr",
		gjcSessionId: request.gjcSessionId,
		sessionStateFile: request.sessionStateFile,
		project: request.project,
		cwd: request.cwd,
		providerIds: ownership.providerIds,
		ownership,
	};
	const pane: GjcMuxOwnedPaneRef = {
		backend: "herdr",
		gjcSessionId: request.gjcSessionId,
		sessionStateFile: request.sessionStateFile,
		project: request.project,
		cwd: request.cwd,
		providerIds: { ...ownership.providerIds, backendPaneId: identity.backendPaneId },
		ownership,
	};
	return { session, pane };
}

function assertHerdrSelected(env: NodeJS.ProcessEnv): void {
	if (resolveGjcMuxBackend(env) !== "herdr") throw new Error("herdr_mux_backend_not_selected");
}

function assertHerdrOwnershipProof(ref: GjcMuxOwnedSessionRef | GjcMuxOwnedPaneRef): void {
	if (ref.ownership.backend !== "herdr") throw new Error(`unsupported_mux_backend:${ref.ownership.backend}`);
	if (ref.ownership.version.proofKind !== "herdr-metadata") throw new Error("herdr_identity_missing:ownership");
	if (ref.ownership.gjcSessionId !== ref.gjcSessionId) throw new Error("herdr_identity_mismatch:gjcSessionId");
	if (ref.ownership.sessionStateFile !== ref.sessionStateFile)
		throw new Error("herdr_identity_mismatch:sessionStateFile");
	if (ref.ownership.project !== ref.project) throw new Error("herdr_identity_mismatch:project");
	if (ref.ownership.cwd !== ref.cwd) throw new Error("herdr_identity_mismatch:cwd");
	if (ref.ownership.providerIds.backendSessionId !== ref.providerIds.backendSessionId)
		throw new Error("herdr_identity_mismatch:backendSessionId");
	if (ref.ownership.providerIds.socketPath !== ref.providerIds.socketPath)
		throw new Error("herdr_identity_mismatch:socketPath");
	if (ref.ownership.providerIds.backendWorkspaceId !== ref.providerIds.backendWorkspaceId)
		throw new Error("herdr_identity_mismatch:backendWorkspaceId");
	if (ref.ownership.providerIds.backendTabId !== ref.providerIds.backendTabId)
		throw new Error("herdr_identity_mismatch:backendTabId");
	if (!ref.providerIds.backendPaneId) throw new Error("herdr_identity_missing:backendPaneId");
	if (ref.ownership.providerIds.backendPaneId !== ref.providerIds.backendPaneId)
		throw new Error("herdr_identity_mismatch:backendPaneId");
}

function assertHerdrSession(session: GjcMuxOwnedSessionRef): void {
	if (session.backend !== "herdr") throw new Error(`unsupported_mux_backend:${session.backend}`);
	if (!session.providerIds.socketPath) throw new Error("herdr_identity_missing:socketPath");
	assertHerdrOwnershipProof(session);
}

function assertHerdrPane(pane: GjcMuxOwnedPaneRef): void {
	if (pane.backend !== "herdr") throw new Error(`unsupported_mux_backend:${pane.backend}`);
	if (!pane.providerIds.socketPath) throw new Error("herdr_identity_missing:socketPath");
	assertHerdrOwnershipProof(pane);
}

function statusEnv(env: NodeJS.ProcessEnv, session: GjcMuxOwnedSessionRef | GjcMuxOwnedPaneRef): NodeJS.ProcessEnv {
	return { ...env, HERDR_SOCKET_PATH: session.providerIds.socketPath };
}

function assertIdentityMatches(ref: GjcMuxOwnedSessionRef | GjcMuxOwnedPaneRef, identity: GjcHerdrIdentity): void {
	const expected = ref.providerIds;
	if (expected.backendSessionId !== identity.backendSessionId)
		throw new Error("herdr_identity_mismatch:backendSessionId");
	if (expected.socketPath !== identity.socketPath) throw new Error("herdr_identity_mismatch:socketPath");
	if (expected.backendWorkspaceId !== identity.backendWorkspaceId)
		throw new Error("herdr_identity_mismatch:backendWorkspaceId");
	if (expected.backendTabId !== identity.backendTabId) throw new Error("herdr_identity_mismatch:backendTabId");
	if (!expected.backendPaneId) throw new Error("herdr_identity_missing:backendPaneId");
	if (expected.backendPaneId !== identity.backendPaneId) throw new Error("herdr_identity_mismatch:backendPaneId");
}

function unsupportedFlow(flow: string): never {
	throw new Error(`unsupported_mux_backend_flow:herdr:${flow}`);
}

function positiveStatusCount(record: Record<string, unknown>, field: "windows" | "panes"): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`herdr_status_parse_failed:${field}`);
	}
	return value;
}

function parseStatusRecord(stdout: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`herdr_status_parse_failed:${message}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("herdr_status_parse_failed:not_object");
	return parsed as Record<string, unknown>;
}

function statusBoolean(record: Record<string, unknown>, field: "attached"): boolean {
	const value = record[field];
	if (typeof value !== "boolean") throw new Error(`herdr_status_parse_failed:${field}`);
	return value;
}

function snapshotFromStatus(
	session: GjcMuxOwnedSessionRef,
	probe: GjcHerdrProbe,
	identity: GjcHerdrIdentity,
	record: Record<string, unknown>,
): GjcMuxSessionSnapshot {
	return {
		session: refsFromIdentity(session, probe, identity).session,
		attached: statusBoolean(record, "attached"),
		windows: positiveStatusCount(record, "windows"),
		panes: positiveStatusCount(record, "panes"),
		createdAt: identity.createdAt,
	};
}

export function createGjcHerdrMuxCapabilityServices(
	options: GjcHerdrMuxServicesOptions = {},
): GjcMuxCapabilityServices {
	const env = options.env ?? process.env;
	const invokeHerdr = options.invokeHerdr ?? defaultInvokeHerdr;
	const ownedSessions = new Map<string, GjcMuxOwnedSessionRef>();

	async function status(session: GjcMuxOwnedSessionRef): Promise<GjcMuxSessionSnapshot | undefined> {
		assertHerdrSelected(env);
		assertHerdrSession(session);
		const commandEnv = statusEnv(mergedEnv(env), session);
		const probe = await probeHerdr(invokeHerdr, commandEnv);
		const result = await invokeChecked(
			invokeHerdr,
			[...probe.schema.commands.status, "--json", "--session", session.providerIds.backendSessionId],
			commandEnv,
			"herdr_unavailable:status",
		);
		const statusRecord = parseStatusRecord(result.stdout);
		const identity = identityFromRecord(statusRecord);
		assertIdentityMatches(session, identity);
		return snapshotFromStatus(session, probe, identity, statusRecord);
	}

	async function launch(request: GjcMuxLaunchRequest): Promise<GjcMuxLaunchResult> {
		assertHerdrSelected(env);
		if (request.visible) throw new Error("unsupported_mux_backend_flow:herdr:visible_launch");
		if (request.command.length === 0) throw new Error("unsupported_mux_backend_flow:herdr:empty_command");
		if (!request.cwd) throw new Error("herdr_launch_missing:cwd");
		if (!request.project) throw new Error("herdr_launch_missing:project");
		if (!request.gjcSessionId) throw new Error("herdr_launch_missing:gjcSessionId");
		if (!request.sessionStateFile) throw new Error("herdr_launch_missing:sessionStateFile");
		const commandEnv = mergedEnv(env, request.env);
		const probe = await probeHerdr(invokeHerdr, commandEnv);
		const sessionName = generatedSessionName(request.gjcSessionId);
		const result = await invokeChecked(
			invokeHerdr,
			[
				...probe.schema.commands.launch,
				"--json",
				"--session",
				sessionName,
				"--cwd",
				request.cwd,
				"--project",
				request.project,
				"--gjc-session-id",
				request.gjcSessionId,
				"--state-file",
				request.sessionStateFile,
				"--",
				...request.command,
			],
			commandEnv,
			"herdr_unavailable:launch",
		);
		const identity = parseIdentity(result.stdout);
		if (identity.backendSessionId !== sessionName) throw new Error("herdr_identity_mismatch:backendSessionId");
		const launched = refsFromIdentity(request, probe, identity);
		ownedSessions.set(launched.session.providerIds.backendSessionId, launched.session);
		const current = await status(launched.session);
		if (current === undefined) throw new Error("herdr_identity_mismatch:status_missing");
		return { session: current.session, pane: launched.pane };
	}

	return {
		resolver: {
			resolveBackend: resolveGjcMuxBackend,
			resolveBackendCommand: resolveGjcMuxBackendCommand,
		},
		launch: { launch },
		sessionReader: {
			async listSessions(project) {
				assertHerdrSelected(env);
				const commandEnv = mergedEnv(env);
				const probe = await probeHerdr(invokeHerdr, commandEnv);
				const result = await invokeChecked(
					invokeHerdr,
					[...probe.schema.commands.list, "--json"],
					commandEnv,
					"herdr_unavailable:list",
				);
				const snapshots: GjcMuxSessionSnapshot[] = [];
				for (const identity of parseIdentityList(result.stdout)) {
					const session = ownedSessions.get(identity.backendSessionId);
					if (!session) continue;
					assertIdentityMatches(session, identity);
					if (project && session.project !== project) continue;
					const snapshot = await status(session);
					if (snapshot) snapshots.push(snapshot);
				}
				return snapshots;
			},
			getSession: status,
		},
		sessionMutator: {
			async attachSession() {
				assertHerdrSelected(env);
				unsupportedFlow("sessionMutator.attachSession");
			},
			async closeSession() {
				assertHerdrSelected(env);
				unsupportedFlow("sessionMutator.closeSession");
			},
		},
		paneMutator: {
			async focusPane() {
				assertHerdrSelected(env);
				unsupportedFlow("paneMutator.focusPane");
			},
			async sendText() {
				assertHerdrSelected(env);
				unsupportedFlow("paneMutator.sendText");
			},
		},
		tailReader: {
			async readTail(request: GjcMuxTailRequest): Promise<GjcMuxTailChunk> {
				assertHerdrSelected(env);
				assertHerdrPane(request.pane);
				const commandEnv = statusEnv(mergedEnv(env), request.pane);
				const probe = await probeHerdr(invokeHerdr, commandEnv);
				const result = await invokeChecked(
					invokeHerdr,
					[
						...probe.schema.commands.tail,
						"--json",
						"--session",
						request.pane.providerIds.backendSessionId,
						"--lines",
						String(request.lines),
						"--pane",
						request.pane.providerIds.backendPaneId,
					],
					commandEnv,
					"herdr_unavailable:tail",
				);
				let parsed: unknown;
				try {
					parsed = JSON.parse(result.stdout);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`herdr_tail_parse_failed:${message}`);
				}
				if (typeof parsed !== "object" || parsed === null) throw new Error("herdr_tail_parse_failed:not_object");
				const record = parsed as Record<string, unknown>;
				if (!Array.isArray(record.lines) || !record.lines.every(line => typeof line === "string")) {
					throw new Error("herdr_tail_parse_failed:lines");
				}
				return { pane: request.pane, lines: record.lines, truncated: record.truncated === true };
			},
		},
		coordinatorDelivery: {
			async deliver() {
				assertHerdrSelected(env);
				unsupportedFlow("coordinatorDelivery.deliver");
			},
		},
		lifecycle: {
			async create() {
				assertHerdrSelected(env);
				unsupportedFlow("lifecycle.create");
			},
			async resume() {
				assertHerdrSelected(env);
				unsupportedFlow("lifecycle.resume");
			},
			async close() {
				assertHerdrSelected(env);
				unsupportedFlow("lifecycle.close");
			},
		},
		gc: {
			async collect(): Promise<readonly GjcMuxGcCandidate[]> {
				assertHerdrSelected(env);
				unsupportedFlow("gc.collect");
			},
			async prune() {
				assertHerdrSelected(env);
				unsupportedFlow("gc.prune");
			},
		},
	};
}

export const createHerdrMuxCapabilityServices = createGjcHerdrMuxCapabilityServices;

export function createGjcMuxCapabilityServices(options: GjcHerdrMuxServicesOptions = {}): GjcMuxCapabilityServices {
	const env = options.env ?? process.env;
	return resolveGjcMuxBackend(env) === "herdr"
		? createGjcHerdrMuxCapabilityServices(options)
		: createGjcTmuxMuxCapabilityServices({ env });
}
