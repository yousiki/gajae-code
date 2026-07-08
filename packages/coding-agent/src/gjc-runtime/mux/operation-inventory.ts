import type { GjcMuxFlowDisposition } from "./types";

export type GjcMuxOperationInventoryId =
	| "interactive-launch"
	| "session-command"
	| "team-runtime"
	| "coordinator-mcp"
	| "notification-lifecycle"
	| "harness-resident-owner"
	| "tmux-gc"
	| "tui-tmux-scroll";

export interface GjcMuxOperationInventoryItem {
	id: GjcMuxOperationInventoryId;
	title: string;
	currentOwners: readonly string[];
	tmuxOperations: readonly string[];
	tmuxConcepts: readonly string[];
	disposition: GjcMuxFlowDisposition;
	herdrMvpBehavior: string;
	verificationAnchors: readonly string[];
	notes: string;
}

export const GJC_MUX_OPERATION_INVENTORY: readonly GjcMuxOperationInventoryItem[] = [
	{
		id: "interactive-launch",
		title: "Interactive --tmux launch and attach",
		currentOwners: ["packages/coding-agent/src/gjc-runtime/launch-tmux.ts"],
		tmuxOperations: [
			"resolve tmux-compatible binary",
			"new-session -d with cwd, size, env, and inner gjc command",
			"has-session race probe",
			"attach-session",
			"kill-session cleanup after failed ownership tagging",
			"rename-window",
			"set-option and set-window-option profile metadata",
			"show-options -gqv status",
			"resize-window only for psmux compatibility",
		],
		tmuxConcepts: [
			"interactive root launch",
			"existing branch session attach",
			"session-scoped exact targets",
			"option-scoped exact targets",
			"GJC ownership profile tags",
			"terminal size propagation",
		],
		disposition: "tmux-adapter-owned",
		herdrMvpBehavior:
			"Route only when GJC_MUX_BACKEND=herdr and GJC_HERDR_COMMAND names an external Herdr binary; otherwise keep the existing tmux launch path unchanged.",
		verificationAnchors: [
			"buildDefaultTmuxLaunchPlan",
			"launchDefaultTmuxIfNeeded",
			"applyGjcTmuxProfile",
			"buildGjcTmuxRootTerminalTitleCommands",
		],
		notes: "The future seam must preserve tmux defaults and keep binary command execution inside backend adapters.",
	},
	{
		id: "session-command",
		title: "gjc session command and tagged session registry",
		currentOwners: [
			"packages/coding-agent/src/commands/session.ts",
			"packages/coding-agent/src/gjc-runtime/tmux-sessions.ts",
		],
		tmuxOperations: [
			"list-sessions with tmux format fields",
			"show-options ownership hydration",
			"new-session -d for managed sessions",
			"set-option ownership tags",
			"attach-session",
			"kill-session",
		],
		tmuxConcepts: [
			"GJC-managed session list/status/create/attach/remove",
			"profile option round-trip",
			"session id and state-file tags",
			"attached/live-pane safety",
		],
		disposition: "tmux-adapter-owned",
		herdrMvpBehavior:
			"Expose equivalent typed session reader/mutator behavior through a Herdr adapter only after Herdr ownership proof can round-trip; tmux remains the default.",
		verificationAnchors: [
			"Session.run",
			"listGjcTmuxSessions",
			"createGjcTmuxSession",
			"statusGjcTmuxSession",
			"removeGjcTmuxSession",
		],
		notes: "Inventory tracks the existing tmux registry owner without extracting or rewiring it in G001.",
	},
	{
		id: "team-runtime",
		title: "Native team runtime panes and command surface",
		currentOwners: [
			"packages/coding-agent/src/gjc-runtime/team-runtime.ts",
			"packages/coding-agent/src/commands/team.ts",
		],
		tmuxOperations: [
			"read leader tmux session profile",
			"show-options profile validation",
			"set-option team metadata via shared profile helper",
			"spawn worker panes and track tmux targets",
			"send worker input to panes",
			"capture worker state through tmux target references",
		],
		tmuxConcepts: [
			"leader session requirement",
			"worker pane identity",
			"tmux target addressing",
			"team state root",
			"dry-run state-only escape",
		],
		disposition: "tmux-adapter-owned",
		herdrMvpBehavior:
			"Herdr MVP may implement team only through typed launch, pane mutation, and tail services; no generic command runner is part of the public contract.",
		verificationAnchors: ["runGjcTeam", "readGjcTmuxProfileValue", "createTeamRuntime", "Team.run"],
		notes: "Later goals can extract tmux parity services; G001 only records the seam and checklist.",
	},
	{
		id: "coordinator-mcp",
		title: "Coordinator MCP visible-session registration and delivery",
		currentOwners: ["packages/coding-agent/src/coordinator-mcp/server.ts"],
		tmuxOperations: [
			"register tmux_session and tmux_target",
			"validate tmux session and target tokens",
			"deliver prompts through tmux key channel",
			"report delivery state and bounded tail through durable state",
		],
		tmuxConcepts: [
			"visible coordinator session",
			"mutation authorization",
			"tmux target delivery",
			"runtime acknowledgement",
		],
		disposition: "tmux-adapter-owned",
		herdrMvpBehavior:
			"Herdr delivery must use a coordinator delivery service with owned pane refs and durable acknowledgements; host-facing raw multiplexer controls stay unavailable.",
		verificationAnchors: [
			"register_session tool schema",
			"start_session tool schema",
			"sanitizeTmuxSession",
			"sanitizeTmuxTarget",
			"tmux.delivery_succeeded",
		],
		notes: "The public MCP contract should remain durable-state oriented rather than exposing backend commands.",
	},
	{
		id: "notification-lifecycle",
		title: "Notification lifecycle daemon create/close/resume effects",
		currentOwners: ["packages/coding-agent/src/notifications/lifecycle-control-runtime.ts"],
		tmuxOperations: [
			"daemon new-session -d create",
			"set-option ownership/profile metadata",
			"force-close managed session",
			"find/status managed tmux sessions",
			"cold-restart resume through new-session -d",
		],
		tmuxConcepts: [
			"daemon-safe detached launch",
			"lifecycle request id",
			"notification-owned session name",
			"hard close with ownership revalidation",
		],
		disposition: "tmux-only-MVP",
		herdrMvpBehavior:
			"Herdr MVP does not replace notification lifecycle effects in G001; keep lifecycle create, close, and resume on tmux until a later goal defines parity.",
		verificationAnchors: ["daemonSpawnCreate", "daemonCloseSession", "daemonResumeSession", "tmuxSessionNameFor"],
		notes: "Explicitly out of Herdr MVP for this skeleton goal.",
	},
	{
		id: "harness-resident-owner",
		title: "Harness resident owner tmux fallback",
		currentOwners: ["packages/coding-agent/src/commands/harness.ts"],
		tmuxOperations: [
			"resolve tmux command",
			"new-session -d resident owner",
			"record tmuxSessionName in viewport handle",
			"fallback to detached owner when tmux is unavailable",
		],
		tmuxConcepts: [
			"resident owner daemon",
			"deterministic harness session",
			"event-monitor viewport",
			"detached fallback",
		],
		disposition: "tmux-only-MVP",
		herdrMvpBehavior:
			"Herdr MVP does not start harness resident owners; the harness keeps its current tmux-or-detached behavior.",
		verificationAnchors: [
			"#startTmuxResidentOwner",
			"#spawnDetachedOwner",
			"deterministicHarnessTmuxSessionName",
			"viewportHandle",
		],
		notes: "Harness ownership is listed so later extraction does not accidentally broaden the G001 contract.",
	},
	{
		id: "tmux-gc",
		title: "tmux session garbage collection and GC adapter registration",
		currentOwners: [
			"packages/coding-agent/src/gjc-runtime/tmux-gc.ts",
			"packages/coding-agent/src/gjc-runtime/gc-runtime.ts",
		],
		tmuxOperations: [
			"list tagged and untagged tmux sessions",
			"read ownership tags for revalidation",
			"classify attached/live/stale/orphan sessions",
			"kill-session only after terminal marker and ownership revalidation",
			"register tmux_sessions GC store adapter",
		],
		tmuxConcepts: [
			"TOCTOU revalidation",
			"terminal runtime marker",
			"GJC ownership tags",
			"attached/live-pane safety",
			"GC_STORES tmux_sessions",
		],
		disposition: "tmux-only-MVP",
		herdrMvpBehavior:
			"Herdr MVP does not prune Herdr sessions through the tmux GC path; keep tmux_sessions GC unchanged until a Herdr GC adapter exists.",
		verificationAnchors: ["tmuxSessionsGcAdapter", "classifyTaggedSession", "revalidateRemovable", "loadGcAdapters"],
		notes: "Destructive cleanup remains tmux-specific and must never be routed through a generic raw command service.",
	},
	{
		id: "tui-tmux-scroll",
		title: "TUI previous-user-input tmux copy-mode action",
		currentOwners: [
			"packages/coding-agent/src/modes/tmux-scroll.ts",
			"packages/coding-agent/src/modes/controllers/input-controller.ts",
			"packages/coding-agent/src/modes/prompt-action-autocomplete.ts",
		],
		tmuxOperations: [
			"require TMUX environment",
			"copy-mode",
			"send-keys -X history-bottom",
			"send-keys -X search-backward previous user prompt pattern",
			"surface TUI warning when not inside tmux or command fails",
		],
		tmuxConcepts: [
			"copy-mode navigation",
			"current pane targeting",
			"prompt action autocomplete",
			"input controller warning",
		],
		disposition: "tmux-only-MVP",
		herdrMvpBehavior:
			"Herdr MVP does not emulate tmux copy-mode scrolling; the action remains tmux-only and may report unsupported outside tmux.",
		verificationAnchors: [
			"scrollTmuxToPreviousUserInput",
			"TMUX_PREVIOUS_USER_INPUT_SEARCH_PATTERN",
			"scrollTmuxPaneToPreviousUserInput",
			"tmux-previous-user-input",
		],
		notes: "This TUI affordance is intentionally not part of the narrow Herdr MVP contract.",
	},
] as const;

export const GJC_MUX_OPERATION_INVENTORY_IDS = GJC_MUX_OPERATION_INVENTORY.map(item => item.id);
