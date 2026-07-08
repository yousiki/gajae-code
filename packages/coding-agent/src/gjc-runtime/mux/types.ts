export type GjcMuxBackendKind = "tmux" | "herdr";

export const GJC_MUX_BACKEND_ENV = "GJC_MUX_BACKEND";
export const GJC_HERDR_COMMAND_ENV = "GJC_HERDR_COMMAND";

export type GjcMuxFlowDisposition = "neutralized" | "tmux-adapter-owned" | "tmux-only-MVP";

export interface GjcMuxProviderIds {
	backendSessionId: string;
	backendPaneId?: string;
	backendWindowId?: string;
	backendClientId?: string;
	backendWorkspaceId?: string;
	backendTabId?: string;
	socketPath?: string;
	endpoint?: string;
}
export const GJC_HERDR_PROVIDER_IDENTITY_KEYS = [
	"backendSessionId",
	"socketPath",
	"backendWorkspaceId",
	"backendTabId",
	"backendPaneId",
] as const;

export type GjcHerdrProviderIdentityKey = (typeof GJC_HERDR_PROVIDER_IDENTITY_KEYS)[number];

export interface GjcMuxVersionProof {
	schemaVersion: number;
	contractVersion: string;
	backendVersion?: string;
	proofKind: "tmux-options" | "herdr-metadata" | "state-file";
	proofData: readonly string[];
}

export interface GjcMuxOwnedSessionRef {
	backend: GjcMuxBackendKind;
	gjcSessionId: string;
	sessionStateFile: string;
	project: string;
	cwd: string;
	providerIds: GjcMuxProviderIds;
	ownership: GjcMuxOwnershipProof;
}

export interface GjcMuxOwnedPaneRef {
	backend: GjcMuxBackendKind;
	gjcSessionId: string;
	sessionStateFile: string;
	project: string;
	cwd: string;
	providerIds: GjcMuxProviderIds & { backendPaneId: string };
	ownership: GjcMuxOwnershipProof;
}

export interface GjcMuxOwnershipProof {
	backend: GjcMuxBackendKind;
	gjcSessionId: string;
	sessionStateFile: string;
	project: string;
	cwd: string;
	providerIds: GjcMuxProviderIds;
	version: GjcMuxVersionProof;
	validatedAt: string;
}

export interface GjcMuxLaunchRequest {
	cwd: string;
	project: string;
	gjcSessionId: string;
	sessionStateFile: string;
	command: readonly string[];
	env: Readonly<Record<string, string>>;
	visible: boolean;
}

export interface GjcMuxLaunchResult {
	session: GjcMuxOwnedSessionRef;
	pane?: GjcMuxOwnedPaneRef;
}

export interface GjcMuxSessionSnapshot {
	session: GjcMuxOwnedSessionRef;
	attached: boolean;
	windows: number;
	panes: number;
	createdAt: string;
}

export interface GjcMuxPaneSnapshot {
	pane: GjcMuxOwnedPaneRef;
	active: boolean;
	title?: string;
	pid?: number;
}

export interface GjcMuxPaneFocusRequest {
	pane: GjcMuxOwnedPaneRef;
}

export interface GjcMuxPaneTextRequest {
	pane: GjcMuxOwnedPaneRef;
	text: string;
}
export interface GjcMuxTailRequest {
	pane: GjcMuxOwnedPaneRef;
	lines: number;
}

export interface GjcMuxTailChunk {
	pane: GjcMuxOwnedPaneRef;
	lines: readonly string[];
	truncated: boolean;
}

export interface GjcMuxCoordinatorDeliveryRequest {
	pane: GjcMuxOwnedPaneRef;
	message: string;
	turnId?: string;
}

export interface GjcMuxCoordinatorDeliveryResult {
	delivered: boolean;
	reason?: string;
}

export interface GjcMuxGcCandidate {
	session: GjcMuxOwnedSessionRef;
	stale: boolean;
	removable: boolean;
	reason: string;
}

export interface GjcMuxBackendResolverService {
	resolveBackend(env: NodeJS.ProcessEnv): GjcMuxBackendKind;
	resolveBackendCommand(env: NodeJS.ProcessEnv): string;
}

export interface GjcMuxLaunchService {
	launch(request: GjcMuxLaunchRequest): Promise<GjcMuxLaunchResult>;
}

export interface GjcMuxSessionReaderService {
	listSessions(project?: string): Promise<readonly GjcMuxSessionSnapshot[]>;
	getSession(session: GjcMuxOwnedSessionRef): Promise<GjcMuxSessionSnapshot | undefined>;
}

export interface GjcMuxSessionMutatorService {
	attachSession(session: GjcMuxOwnedSessionRef): Promise<void>;
	closeSession(session: GjcMuxOwnedSessionRef): Promise<GjcMuxSessionSnapshot>;
}

export interface GjcMuxPaneMutatorService {
	focusPane(pane: GjcMuxOwnedPaneRef): Promise<void>;
	sendText(pane: GjcMuxOwnedPaneRef, text: string): Promise<void>;
}

export interface GjcMuxTailReaderService {
	readTail(request: GjcMuxTailRequest): Promise<GjcMuxTailChunk>;
}

export interface GjcMuxCoordinatorDeliveryService {
	deliver(request: GjcMuxCoordinatorDeliveryRequest): Promise<GjcMuxCoordinatorDeliveryResult>;
}

export interface GjcMuxLifecycleService {
	create(request: GjcMuxLaunchRequest): Promise<GjcMuxLaunchResult>;
	resume(session: GjcMuxOwnedSessionRef): Promise<GjcMuxOwnedSessionRef>;
	close(session: GjcMuxOwnedSessionRef): Promise<boolean>;
}

export interface GjcMuxGcService {
	collect(project?: string): Promise<readonly GjcMuxGcCandidate[]>;
	prune(candidate: GjcMuxGcCandidate): Promise<boolean>;
}

export const GJC_PUBLIC_MUX_CAPABILITY_SERVICE_KEYS = [
	"resolver",
	"launch",
	"sessionReader",
	"sessionMutator",
	"paneMutator",
	"tailReader",
	"coordinatorDelivery",
	"lifecycle",
	"gc",
] as const;

export type GjcPublicMuxCapabilityServiceKey = (typeof GJC_PUBLIC_MUX_CAPABILITY_SERVICE_KEYS)[number];

export interface GjcMuxCapabilityServices {
	resolver: GjcMuxBackendResolverService;
	launch: GjcMuxLaunchService;
	sessionReader: GjcMuxSessionReaderService;
	sessionMutator: GjcMuxSessionMutatorService;
	paneMutator: GjcMuxPaneMutatorService;
	tailReader: GjcMuxTailReaderService;
	coordinatorDelivery: GjcMuxCoordinatorDeliveryService;
	lifecycle: GjcMuxLifecycleService;
	gc: GjcMuxGcService;
}
