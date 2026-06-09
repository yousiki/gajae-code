import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import type { CustomMessage } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools/index";
import { JobTool } from "../src/tools/job";
import { MonitorTool } from "../src/tools/monitor";

// End-to-end integration: MonitorTool/JobTool lifecycle against a REAL Agent
// follow-up queue and REAL AgentSession.purgeQueuedCustomMessages, exercising the
// exact "persistent monitor flood" path that survived process death + eviction.
//
// `sendCustomMessage` routes to `agent.followUp(...)`, which is byte-identical to
// AgentSession's streaming dispatch branch (deliverAs:"followUp" -> agent.followUp)
// — the mid-turn path that produced the original backlog. The purge side is the
// real AgentSession method operating on the real Agent #followUpQueue, so cap +
// purge behavior is verified against the actual executable queue, not a stub.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function createRealSession(ownerId: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const agent = new Agent({ initialState: { model, messages: [], tools: [] } });
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	const tool: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: session.settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => `session-${ownerId}`,
		getAgentId: () => ownerId,
		sendCustomMessage: (m: CustomMessage) => {
			agent.followUp({ role: "custom", ...(m as object), timestamp: Date.now() } as never);
			return Promise.resolve();
		},
		purgeQueuedCustomMessages: (p: (message: CustomMessage) => boolean) => session.purgeQueuedCustomMessages(p),
		allocateOutputArtifact: async () => ({}),
	} as unknown as ToolSession;
	const notificationDepth = () =>
		agent.snapshotFollowUp().filter(m => (m as CustomMessage).customType === "task-notification").length;
	return { agent, session, tool, notificationDepth };
}

describe("monitor + real AgentSession integration", () => {
	const previousInstance = AsyncJobManager.instance();
	let manager: AsyncJobManager;

	beforeEach(() => {
		manager = new AsyncJobManager({ retentionMs: 1000, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 200 });
		AsyncJobManager.setInstance(previousInstance);
	});

	it("bounds the real follow-up backlog for a chatty persistent monitor and preserves the newest state", async () => {
		const { agent, tool, notificationDepth } = await createRealSession("0-A");
		const monitor = new MonitorTool(tool);
		const lines = 40;
		await monitor.execute("call-a", {
			command: `for i in $(seq 1 ${lines}); do echo "0 passed, 2 pending, 0 failed"; sleep 0.01; done; echo "0 passed, 0 pending, 2 failed"`,
			kind: "poll",
			description: "release CI watch",
			persistent: true,
		} as never);

		let peak = 0;
		for (let i = 0; i < 200; i++) {
			await sleep(15);
			peak = Math.max(peak, notificationDepth());
			if (manager.getAllJobs({ ownerId: "0-A" }).every(j => j.status !== "running")) break;
		}
		await sleep(30);

		// Backlog stays bounded by the cap instead of growing one-per-line.
		expect(peak).toBeLessThanOrEqual(3);
		expect(notificationDepth()).toBeLessThanOrEqual(3);
		// The newest terminal state is never lost to coalescing/cap.
		const last = agent
			.snapshotFollowUp()
			.filter(m => (m as CustomMessage).customType === "task-notification")
			.at(-1);
		expect(String((last as CustomMessage | undefined)?.content ?? "")).toContain("0 passed, 0 pending, 2 failed");
	});

	it("purges the real Agent follow-up queue when the monitor is cancelled", async () => {
		const { agent, tool, notificationDepth } = await createRealSession("0-B");
		const monitor = new MonitorTool(tool);
		const res = await monitor.execute("call-b", {
			command: "sleep 5",
			kind: "poll",
			description: "long monitor",
			persistent: true,
		} as never);
		const jobId = (res.details as { taskId: string }).taskId;

		// Mid-turn enqueue that produced the original flood: real task-notifications
		// for this monitor's taskId in the real Agent #followUpQueue.
		for (let i = 0; i < 25; i++) {
			agent.followUp({
				role: "custom",
				customType: "task-notification",
				content: `0 passed, 2 pending, 0 failed (#${i})`,
				display: false,
				details: { taskId: jobId, kind: "poll", description: "long monitor" },
				attribution: "agent",
				timestamp: Date.now(),
			} as never);
		}
		expect(notificationDepth()).toBe(25);

		expect(manager.cancel(jobId, { ownerId: "0-B" })).toBe(true);
		await sleep(30);

		expect(notificationDepth()).toBe(0);
	});

	it("lets a post-eviction job cancel purge via tombstone instead of returning not_found", async () => {
		const evManager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(evManager);
		try {
			const { tool } = await createRealSession("0-C");
			const monitor = new MonitorTool(tool);
			const res = await monitor.execute("call-c", {
				command: 'echo "0 passed, 2 pending, 0 failed"',
				kind: "poll",
				description: "evicted",
				persistent: true,
			} as never);
			const jobId = (res.details as { taskId: string }).taskId;
			await evManager.waitForAll();
			await sleep(20);

			expect(evManager.getJob(jobId)).toBeUndefined();

			const jobTool = new JobTool(tool);
			const cancelled = await jobTool.execute("cancel-known", { cancel: [jobId] } as never);
			const cancelledText = cancelled.content.map(p => ("text" in p ? p.text : "")).join(" ");
			expect(cancelledText).toContain("already gone");
			expect(cancelledText).not.toContain("not found");

			const unknown = await jobTool.execute("cancel-unknown", { cancel: ["bg_missing"] } as never);
			const unknownText = unknown.content.map(p => ("text" in p ? p.text : "")).join(" ");
			expect(unknownText).toContain("not found");
		} finally {
			await evManager.dispose({ timeoutMs: 200 });
		}
	});
});
