import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	createGjcHerdrMuxCapabilityServices,
	createGjcMuxCapabilityServices,
	createHerdrMuxCapabilityServices,
	GJC_HERDR_COMMAND_ENV,
	GJC_HERDR_PROVIDER_IDENTITY_KEYS,
	GJC_MUX_BACKEND_ENV,
	GJC_MUX_OPERATION_INVENTORY,
	GJC_MUX_OPERATION_INVENTORY_IDS,
	GJC_PUBLIC_MUX_CAPABILITY_SERVICE_KEYS,
} from "@gajae-code/coding-agent/gjc-runtime/mux/index";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");

async function readRepoFile(...segments: string[]): Promise<string> {
	return await Bun.file(path.join(repoRoot, ...segments)).text();
}

const expectedInventoryIds = [
	"interactive-launch",
	"session-command",
	"team-runtime",
	"coordinator-mcp",
	"notification-lifecycle",
	"harness-resident-owner",
	"tmux-gc",
	"tui-tmux-scroll",
] as const;

const expectedOwnerPaths = [
	"packages/coding-agent/src/gjc-runtime/launch-tmux.ts",
	"packages/coding-agent/src/commands/session.ts",
	"packages/coding-agent/src/gjc-runtime/tmux-sessions.ts",
	"packages/coding-agent/src/gjc-runtime/team-runtime.ts",
	"packages/coding-agent/src/commands/team.ts",
	"packages/coding-agent/src/coordinator-mcp/server.ts",
	"packages/coding-agent/src/notifications/lifecycle-control-runtime.ts",
	"packages/coding-agent/src/commands/harness.ts",
	"packages/coding-agent/src/gjc-runtime/tmux-gc.ts",
	"packages/coding-agent/src/gjc-runtime/gc-runtime.ts",
	"packages/coding-agent/src/modes/tmux-scroll.ts",
	"packages/coding-agent/src/modes/controllers/input-controller.ts",
	"packages/coding-agent/src/modes/prompt-action-autocomplete.ts",
] as const;

describe("mux contract skeleton", () => {
	it("contains exactly the G001 operation inventory ids", () => {
		expect([...GJC_MUX_OPERATION_INVENTORY_IDS]).toEqual([...expectedInventoryIds]);
		expect(GJC_MUX_OPERATION_INVENTORY.map(item => item.id)).toEqual([...expectedInventoryIds]);
	});

	it("covers every expected tmux owner path", () => {
		const owners = new Set(GJC_MUX_OPERATION_INVENTORY.flatMap(item => item.currentOwners));
		expect([...owners].sort()).toEqual([...expectedOwnerPaths].sort());
	});

	it("requires disposition, Herdr MVP behavior, and verification anchors for every item", () => {
		for (const item of GJC_MUX_OPERATION_INVENTORY) {
			expect(item.disposition).toMatch(/^(neutralized|tmux-adapter-owned|tmux-only-MVP)$/);
			expect(item.herdrMvpBehavior.trim().length).toBeGreaterThan(0);
			expect(item.verificationAnchors.length).toBeGreaterThan(0);
			expect(item.verificationAnchors.every(anchor => anchor.trim().length > 0)).toBe(true);
		}
	});

	it("keeps lifecycle, GC, harness, and tmux-scroll explicitly tmux-only for MVP", () => {
		const dispositionById = new Map(GJC_MUX_OPERATION_INVENTORY.map(item => [item.id, item.disposition]));
		expect(dispositionById.get("notification-lifecycle")).toBe("tmux-only-MVP");
		expect(dispositionById.get("tmux-gc")).toBe("tmux-only-MVP");
		expect(dispositionById.get("harness-resident-owner")).toBe("tmux-only-MVP");
		expect(dispositionById.get("tui-tmux-scroll")).toBe("tmux-only-MVP");
	});

	it("does not expose a generic runCommand public capability service", () => {
		for (const key of GJC_PUBLIC_MUX_CAPABILITY_SERVICE_KEYS) {
			expect(key).not.toBe("runCommand");
			expect(key.toLowerCase()).not.toContain("runcommand");
		}
	});

	it("pins Herdr identity to session, socket, workspace, tab, and pane keys", () => {
		expect(GJC_HERDR_PROVIDER_IDENTITY_KEYS).toEqual([
			"backendSessionId",
			"socketPath",
			"backendWorkspaceId",
			"backendTabId",
			"backendPaneId",
		]);
	});

	it("uses confirmed mux selector environment constant names", () => {
		expect(GJC_MUX_BACKEND_ENV).toBe("GJC_MUX_BACKEND");
		expect(GJC_HERDR_COMMAND_ENV).toBe("GJC_HERDR_COMMAND");
	});

	it("documents the experimental Herdr mux backend boundary", async () => {
		const envDoc = await readRepoFile("docs", "environment-variables.md");
		const readme = await readRepoFile("README.md");
		const botGuide = await readRepoFile("docs", "bot-integration.md");

		for (const doc of [envDoc, readme]) {
			expect(doc).toContain("GJC_MUX_BACKEND=herdr");
			expect(doc).toContain("GJC_HERDR_COMMAND");
			expect(doc).toContain("not bundled");
			expect(doc).toContain("not selected by default");
			expect(doc).toContain("typed launch/session/tail/list MVP");
		}
		expect(envDoc).toContain("tmux remains the default");
		expect(envDoc).toContain("Non-MVP flows stay tmux-only");
		expect(botGuide).toContain("not a Coordinator MCP lifecycle backend");
		expect(botGuide).toContain("Use `GJC_TMUX_COMMAND`");
	});

	it("keeps the Team prompt on the tmux runtime despite Herdr experiments", async () => {
		const teamSkill = await readRepoFile(
			"packages",
			"coding-agent",
			"src",
			"defaults",
			"gjc",
			"skills",
			"team",
			"SKILL.md",
		);

		expect(teamSkill).toContain("Team remains a tmux-backed runtime");
		expect(teamSkill).toContain("GJC_MUX_BACKEND=herdr");
		expect(teamSkill).toContain("GJC_TMUX_COMMAND");
		expect(teamSkill).toContain("Coordinator/team/lifecycle/GC/harness/tmux-scroll flows stay unsupported");
	});

	it("exports internal Herdr factories without adding public mux capabilities", () => {
		expect(typeof createGjcMuxCapabilityServices).toBe("function");
		expect(typeof createGjcHerdrMuxCapabilityServices).toBe("function");
		expect(createHerdrMuxCapabilityServices).toBe(createGjcHerdrMuxCapabilityServices);
		expect(GJC_PUBLIC_MUX_CAPABILITY_SERVICE_KEYS).toEqual([
			"resolver",
			"launch",
			"sessionReader",
			"sessionMutator",
			"paneMutator",
			"tailReader",
			"coordinatorDelivery",
			"lifecycle",
			"gc",
		]);
	});
});
