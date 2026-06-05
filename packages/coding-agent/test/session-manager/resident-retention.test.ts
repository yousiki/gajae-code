import { describe, expect, it } from "bun:test";
import type { ImageContent, Message, ProviderPayload, TextContent } from "@gajae-code/ai";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
} from "@gajae-code/coding-agent/session/session-storage";
import { getBlobsDir } from "@gajae-code/utils";

const LARGE_TEXT = "T".repeat(700_000);
const LARGE_IMAGE = Buffer.alloc(180_000, 7).toString("base64");
const LARGE_PROVIDER_IMAGE_URL = `data:image/png;base64,${Buffer.alloc(180_000, 9).toString("base64")}`;
const TRUNCATION_NOTICE = "[Session persistence truncated large content]";
const BLOB_REF = "blob:sha256:";
const SAME_BYTES = Buffer.from("same bytes for text and image".repeat(30_000));
const SAME_BYTES_TEXT = SAME_BYTES.toString("utf8");
const SAME_BYTES_IMAGE = SAME_BYTES.toString("base64");

function assistantMessage(
	content: Extract<Message, { role: "assistant" }>["content"] = [{ type: "text", text: "ok" }],
): Message {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			premiumRequests: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function largeUserMessage(): Message {
	return {
		role: "user",
		content: [
			{ type: "text", text: LARGE_TEXT },
			{ type: "image", data: LARGE_IMAGE, mimeType: "image/png" },
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [
				{ type: "message", role: "user", content: [{ type: "input_image", image_url: LARGE_PROVIDER_IMAGE_URL }] },
			],
		} satisfies ProviderPayload,
		timestamp: 1,
	};
}

function residentJson(session: SessionManager): string {
	return JSON.stringify(session.captureState().fileEntries);
}

function expectResidentBounded(session: SessionManager): void {
	const json = residentJson(session);
	expect(json).toContain(BLOB_REF);
	expect(json).not.toContain(LARGE_TEXT.slice(0, 100));
	expect(json).not.toContain(LARGE_IMAGE.slice(0, 100));
	expect(json).not.toContain(LARGE_PROVIDER_IMAGE_URL.slice(0, 100));
	expect(json.length).toBeLessThan(20_000);
}

async function persistedText(session: SessionManager, storage: MemorySessionStorage): Promise<string> {
	await session.flush();
	return storage.readTextSync(session.getSessionFile()!);
}

class ThrowingWriterStorage extends MemorySessionStorage {
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = super.openWriter(path, options);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: () => {
				throw new Error("sync persist failed");
			},
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	}
}

class ThrowingRewriteStorage extends MemorySessionStorage {
	shouldThrowSyncWrite = false;

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = super.openWriter(path, options);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: line => {
				if (this.shouldThrowSyncWrite && path.includes(".tmp")) throw new Error("sync rewrite failed");
				writer.writeLineSync(line);
			},
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	}
}

describe("SessionManager resident retention boundaries", () => {
	it("keeps resident entries bounded after fresh large appends while readers materialize full content and JSONL stays capped text", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const small = { role: "user" as const, content: "small exact", timestamp: 0 };
		session.appendMessage(small);
		session.appendMessage(assistantMessage());
		const before = await persistedText(session, storage);

		const largeId = session.appendMessage(largeUserMessage());
		session.appendMessage(assistantMessage());
		const persisted = await persistedText(session, storage);

		expectResidentBounded(session);
		expect(persisted).not.toContain(BLOB_REF);
		expect(persisted).toContain(TRUNCATION_NOTICE);
		expect(persisted).toContain(LARGE_TEXT.slice(0, 100));
		expect(persisted).toContain(LARGE_IMAGE.slice(0, 100));
		expect(persisted).toContain(LARGE_PROVIDER_IMAGE_URL.slice(0, 100));
		expect(before).toContain(JSON.stringify(small));

		const entry = session.getEntry(largeId);
		expect(entry?.type).toBe("message");
		const message = entry?.type === "message" ? entry.message : undefined;
		expect(JSON.stringify(message)).toContain(LARGE_TEXT);
		expect(JSON.stringify(message)).toContain(LARGE_IMAGE);
		expect(JSON.stringify(message)).toContain(LARGE_PROVIDER_IMAGE_URL);
		expect(JSON.stringify(session.buildSessionContext().messages)).toContain(LARGE_TEXT);
	});

	it("re-externalizes branch residents after creating a branch from a large-output path", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const largeId = session.appendMessage(largeUserMessage());
		session.appendMessage(assistantMessage());

		const branchFile = session.createBranchedSession(largeId);
		expect(branchFile).toBeString();
		expectResidentBounded(session);
		const entry = session.getEntry(largeId);
		expect(JSON.stringify(entry)).toContain(LARGE_TEXT);
		expect(storage.readTextSync(branchFile!)).not.toContain(BLOB_REF);
	});

	it("keeps residents bounded after reload and fork while materializing readers", async () => {
		const storage = new MemorySessionStorage();
		const original = SessionManager.create("/cwd", "/sessions", storage);
		const largeId = original.appendMessage(largeUserMessage());
		original.appendMessage(assistantMessage());
		await original.flush();
		const sessionFile = original.getSessionFile()!;

		const reloaded = await SessionManager.open(sessionFile, "/sessions", storage);
		expectResidentBounded(reloaded);
		expect(JSON.stringify(reloaded.getEntry(largeId))).toContain(LARGE_PROVIDER_IMAGE_URL);

		const forked = await SessionManager.forkFrom(sessionFile, "/cwd", "/sessions", storage);
		expectResidentBounded(forked);
		expect(JSON.stringify(forked.buildSessionContext().messages)).toContain(TRUNCATION_NOTICE);
		expect(storage.readTextSync(forked.getSessionFile()!)).not.toContain(BLOB_REF);
	});

	it("rethrows synchronous persist failures from append", () => {
		const storage: SessionStorage = new ThrowingWriterStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		expect(() => session.appendMessage(assistantMessage())).toThrow("sync persist failed");
	});

	it("preserves the previous JSONL after sync rewrite failure", () => {
		const storage = new ThrowingRewriteStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const sessionFile = session.getSessionFile()!;
		session.appendMessage(assistantMessage());
		const before = storage.readTextSync(sessionFile);
		session.restoreState({ ...session.captureState(), flushed: false });

		storage.shouldThrowSyncWrite = true;
		expect(() => session.appendCustomEntry("large", { payload: LARGE_TEXT })).toThrow("sync rewrite failed");

		expect(storage.readTextSync(sessionFile)).toBe(before);
		expect(storage.readTextSync(sessionFile)).toContain("first");
		expect(storage.readTextSync(sessionFile)).not.toBe("");
	});

	it("keeps in-memory resident blobs off the global blob dir while readers materialize full content", () => {
		const storage = new MemorySessionStorage();
		const blobsDir = getBlobsDir();
		const before = new Set(storage.listFilesSync(blobsDir, "*"));
		const session = SessionManager.inMemory("/cwd", storage);
		const id = session.appendMessage(largeUserMessage());

		expectResidentBounded(session);
		expect(new Set(storage.listFilesSync(blobsDir, "*"))).toEqual(before);
		expect(JSON.stringify(session.getEntry(id))).toContain(LARGE_TEXT);
		expect(JSON.stringify(session.buildSessionContext().messages)).toContain(LARGE_IMAGE);
	});

	it("materializes the same blob bytes independently for text and image decode modes", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.inMemory("/cwd", storage);
		const text = SAME_BYTES_TEXT;
		const image = SAME_BYTES_IMAGE;
		const id = session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text },
				{ type: "image", data: image, mimeType: "image/png" },
			] satisfies (TextContent | ImageContent)[],
			timestamp: 1,
		});

		const entry = session.getEntry(id);
		expect(entry?.type).toBe("message");
		const content =
			entry?.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)
				? entry.message.content
				: [];
		expect(content[0]).toEqual({ type: "text", text });
		expect(content[1]).toEqual({ type: "image", data: image, mimeType: "image/png" });
	});

	it("keeps large custom payloads bounded in resident entries while materializing readers", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const id = session.appendCustomEntry("large-custom", { arbitraryPayload: LARGE_TEXT });

		expectResidentBounded(session);
		expect(JSON.stringify(session.captureState().fileEntries)).not.toContain(LARGE_TEXT.slice(0, 100));
		expect(JSON.stringify(session.getEntry(id))).toContain(LARGE_TEXT);
	});

	it("materializes generic data-key resident strings as utf8 text, not image base64", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const genericContent = { data: LARGE_TEXT } as unknown as Message["content"];
		const id = session.appendMessage({ role: "user", content: genericContent, timestamp: 1 });
		const base64Text = Buffer.from(LARGE_TEXT, "utf8").toString("base64");

		expectResidentBounded(session);
		expect(JSON.stringify(session.captureState().fileEntries)).not.toContain(LARGE_TEXT.slice(0, 100));

		const entry = session.getEntry(id);
		expect(entry?.type).toBe("message");
		const materializedContent = entry?.type === "message" ? entry.message.content : undefined;
		expect(materializedContent).toEqual({ data: LARGE_TEXT });
		expect(session.getEntries().find(item => item.id === id)).toEqual(entry);
		expect(session.buildSessionContext().messages.find(message => message.role === "user")?.content).toEqual({
			data: LARGE_TEXT,
		});
		expect(JSON.stringify(entry)).not.toContain(base64Text.slice(0, 100));
	});
});
