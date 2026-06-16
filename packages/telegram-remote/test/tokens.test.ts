import { describe, expect, test } from "bun:test";
import { CALLBACK_PREFIX, CallbackTokenStore } from "../src/tokens";

describe("CallbackTokenStore", () => {
	test("round-trips list callback payloads", () => {
		const store = new CallbackTokenStore({ now: () => 100 });
		const data = store.issue({
			action: "sessions_filter",
			filter: "blocked",
			query: "feat x",
			page: 2,
			chatId: "chat-1",
			userId: "user-1",
			ttlMs: 1000,
		});
		expect(data.startsWith(CALLBACK_PREFIX)).toBe(true);
		expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
		const resolved = store.resolve(data, { chatId: "chat-1", userId: "user-1" });
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.record).toMatchObject({
				action: "sessions_filter",
				filter: "blocked",
				query: "feat x",
				page: 2,
				chatId: "chat-1",
				userId: "user-1",
			});
			expect("sessionId" in resolved.record).toBe(false);
		}
	});
});
