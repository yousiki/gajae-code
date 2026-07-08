import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { GcContext, GcRecord, GcStoreAdapter } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import {
	createTmuxMuxCapabilityServices,
	GJC_PUBLIC_MUX_CAPABILITY_SERVICE_KEYS,
	type GjcMuxOwnedPaneRef,
} from "@gajae-code/coding-agent/gjc-runtime/mux/index";

interface SpawnSyncResultShape {
	exitCode: number;
	stdout: Buffer;
	stderr: Buffer;
}

type SpawnSyncSpy = { mockImplementation(implementation: (command: string[]) => SpawnSyncResultShape): void };

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResultShape {
	return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function ownedPane(): GjcMuxOwnedPaneRef {
	return {
		backend: "tmux",
		gjcSessionId: "s123",
		sessionStateFile: "/tmp/gjc-session.json",
		project: "/repo-a",
		cwd: "/repo-a",
		providerIds: { backendSessionId: "gajae_code_abc", backendPaneId: "%7" },
		ownership: {
			backend: "tmux",
			gjcSessionId: "s123",
			sessionStateFile: "/tmp/gjc-session.json",
			project: "/repo-a",
			cwd: "/repo-a",
			providerIds: { backendSessionId: "gajae_code_abc", backendPaneId: "%7" },
			version: {
				schemaVersion: 1,
				contractVersion: "tmux-gjc-options-v1",
				proofKind: "tmux-options",
				proofData: ["@gjc-profile=1"],
			},
			validatedAt: "2026-02-02T02:40:00.000Z",
		},
	};
}

describe("tmux mux capability services", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("maps GJC tmux session status into backend-neutral snapshots with ownership proof", async () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((command: string[]) => {
			if (command.includes("list-sessions")) {
				return spawnResult(
					0,
					[
						"gajae_code_abc",
						"2",
						"1",
						"1770000000",
						"1",
						"root",
						"3",
						"12345",
						"feature/demo",
						"feature-demo",
						"/repo-a",
						"s123",
						"/tmp/gjc-session.json",
						"v1",
					].join("\t"),
				);
			}
			return spawnResult(0, "");
		});

		const services = createTmuxMuxCapabilityServices({ env: { GJC_TMUX_COMMAND: "tmux-test" } });
		const sessions = await services.sessionReader.listSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			attached: true,
			windows: 2,
			panes: 3,
			createdAt: "2026-02-02T02:40:00.000Z",
			session: {
				backend: "tmux",
				gjcSessionId: "s123",
				sessionStateFile: "/tmp/gjc-session.json",
				project: "/repo-a",
				providerIds: { backendSessionId: "gajae_code_abc" },
				ownership: {
					backend: "tmux",
					gjcSessionId: "s123",
					version: { proofKind: "tmux-options" },
				},
			},
		});
		expect(sessions[0]?.session.ownership.version.proofData).toContain("@gjc-profile=1");
		expect(sessions[0]?.session.ownership.version.proofData).toContain("@gjc-session-id=s123");
	});

	it("resolver honors GJC_TMUX_COMMAND while reporting the tmux backend", () => {
		const services = createTmuxMuxCapabilityServices();

		expect(services.resolver.resolveBackend({ GJC_TMUX_COMMAND: "psmux" })).toBe("tmux");
		expect(services.resolver.resolveBackendCommand({ GJC_TMUX_COMMAND: "psmux" })).toBe("psmux");
	});

	it("filters psmux-incompatible profile commands for detected tmux aliases during launch wrapper creation", async () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((command: string[]) => {
			if (command.includes("list-sessions")) {
				return spawnResult(
					0,
					[
						"gjc_lc_s123",
						"1",
						"0",
						"1770000000",
						"1",
						"root",
						"1",
						"12345",
						"",
						"",
						"/repo-a",
						"s123",
						"/tmp/gjc-session.json",
						"v1",
					].join("\t"),
				);
			}
			return spawnResult(0, "");
		});
		const calls: string[][] = [];
		const services = createTmuxMuxCapabilityServices({
			env: { GJC_TMUX_COMMAND: "tmux", GJC_PSMUX_COMMAND: "psmux" },
			invokeTmux: argv => {
				calls.push([...argv]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});

		await services.launch.launch({
			cwd: "/repo-a",
			project: "/repo-a",
			gjcSessionId: "s123",
			sessionStateFile: "/tmp/gjc-session.json",
			command: ["gjc"],
			env: {},
			visible: false,
		});

		expect(calls.some(call => call[0] === "set-window-option")).toBe(false);
		expect(calls.some(call => call.includes("mouse"))).toBe(false);
		expect(calls.some(call => call.includes("set-clipboard"))).toBe(false);
		expect(calls.some(call => call.includes("@gjc-profile"))).toBe(true);
		expect(calls.some(call => call.includes("@gjc-session-id") && call.includes("s123"))).toBe(true);
	});

	it("allows GJC_PSMUX_PROFILE_FORCE to keep psmux UX profile commands", async () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((command: string[]) => {
			if (command.includes("list-sessions")) {
				return spawnResult(
					0,
					[
						"gjc_lc_s123",
						"1",
						"0",
						"1770000000",
						"1",
						"root",
						"1",
						"12345",
						"",
						"",
						"/repo-a",
						"s123",
						"/tmp/gjc-session.json",
						"v1",
					].join("\t"),
				);
			}
			return spawnResult(0, "");
		});
		const calls: string[][] = [];
		const services = createTmuxMuxCapabilityServices({
			env: { GJC_TMUX_COMMAND: "tmux", GJC_PSMUX_COMMAND: "psmux", GJC_PSMUX_PROFILE_FORCE: "1" },
			invokeTmux: argv => {
				calls.push([...argv]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});

		await services.launch.launch({
			cwd: "/repo-a",
			project: "/repo-a",
			gjcSessionId: "s123",
			sessionStateFile: "/tmp/gjc-session.json",
			command: ["gjc"],
			env: {},
			visible: false,
		});

		expect(calls.some(call => call[0] === "set-window-option" && call.includes("mode-style"))).toBe(true);
		expect(calls.some(call => call.includes("mouse"))).toBe(true);
		expect(calls.some(call => call.includes("set-clipboard"))).toBe(true);
	});

	it("rejects visible tmux lifecycle launches instead of silently ignoring them", async () => {
		const services = createTmuxMuxCapabilityServices({
			invokeTmux: () => {
				throw new Error("tmux should not be invoked");
			},
		});

		await expect(
			services.launch.launch({
				cwd: "/repo-a",
				project: "/repo-a",
				gjcSessionId: "s123",
				sessionStateFile: "/tmp/gjc-session.json",
				command: ["gjc"],
				env: {},
				visible: true,
			}),
		).rejects.toThrow("unsupported_tmux_lifecycle_visible_mode");
	});

	it("uses typed pane refs for focus, send, tail, and coordinator delivery argv", async () => {
		const calls: readonly string[][] = [];
		const services = createTmuxMuxCapabilityServices({
			env: { GJC_TMUX_COMMAND: "tmux-test" },
			invokeTmux: argv => {
				(calls as string[][]).push([...argv]);
				return { exitCode: 0, stdout: argv[0] === "capture-pane" ? "zero\none\n\ntwo\n" : "", stderr: "" };
			},
		});
		const pane = ownedPane();

		await services.paneMutator.focusPane(pane);
		await services.paneMutator.sendText(pane, "hello world");
		const tail = await services.tailReader.readTail({ pane, lines: 3 });
		await services.coordinatorDelivery.deliver({ pane, message: "coordinator message", turnId: "turn-1" });

		expect(tail.lines).toEqual(["one", "", "two"]);
		const bufferName = calls[3]?.[2];
		expect(bufferName?.startsWith("gjc-coordinator-prompt-")).toBe(true);
		expect(calls).toEqual([
			["select-pane", "-t", "%7"],
			["send-keys", "-l", "-t", "%7", "hello world"],
			["capture-pane", "-p", "-t", "%7", "-S", "-3"],
			["set-buffer", "-b", bufferName, "--", "coordinator message"],
			["paste-buffer", "-d", "-b", bufferName, "-t", "%7"],
			["send-keys", "-t", "%7", "Escape"],
			["send-keys", "-t", "%7", "Enter"],
		]);
	});

	it("redacts payload-bearing argv from fallback tmux errors", async () => {
		const services = createTmuxMuxCapabilityServices({
			invokeTmux: argv => ({ exitCode: 1, stdout: "", stderr: argv[0] === "set-buffer" ? "" : "unexpected" }),
		});

		let message = "";
		try {
			await services.coordinatorDelivery.deliver({ pane: ownedPane(), message: "secret prompt", turnId: "turn-1" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("tmux set-buffer -b");
		expect(message).not.toContain("secret prompt");
	});

	it("wraps tmux GC collect and prune through the existing adapter shape", async () => {
		const records: GcRecord[] = [
			{
				store: "tmux_sessions",
				id: "gajae_code_done",
				path: "/repo-a",
				root: "/repo-a",
				pid_status: "none",
				status: "stale",
				stale: true,
				removable: true,
				action: "none",
				reason: "terminal_runtime_marker_detached_idle_session",
			},
		];
		const seen: { collect?: GcContext; prune?: { record: GcRecord; ctx: GcContext } } = {};
		const gcAdapter: GcStoreAdapter = {
			store: "tmux_sessions",
			async collect(ctx) {
				seen.collect = ctx;
				return { records, errors: [] };
			},
			async prune(record, ctx) {
				seen.prune = { record, ctx };
				return { removed: true };
			},
		};
		const services = createTmuxMuxCapabilityServices({ env: { GJC_TMUX_COMMAND: "tmux-test" }, gcAdapter });

		const candidates = await services.gc.collect("/repo-a");
		const pruned = await services.gc.prune(candidates[0]!);

		expect(candidates.map(candidate => candidate.session.providerIds.backendSessionId)).toEqual(["gajae_code_done"]);
		expect(candidates[0]).toMatchObject({ stale: true, removable: true });
		expect(seen.collect?.env.GJC_TMUX_COMMAND).toBe("tmux-test");
		expect(seen.collect?.cwd).toBe("/repo-a");
		expect(seen.prune?.record).toBe(records[0]);
		expect(pruned).toBe(true);
	});

	it("does not publish a generic runCommand capability key", () => {
		expect(GJC_PUBLIC_MUX_CAPABILITY_SERVICE_KEYS).not.toContain("runCommand");
		expect(Object.keys(createTmuxMuxCapabilityServices())).not.toContain("runCommand");
	});
});
