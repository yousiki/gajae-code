import { afterEach, describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import type { Context, Model, ToolCall } from "@gajae-code/ai/types";

// Coverage for the Anthropic tool-call-XML healer wired into the chat-completions
// provider (e.g. a Claude model served via an OpenAI-compatible relay).

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});

interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{ index: number; delta: { content?: string }; finish_reason?: "stop" | "length" | null }>;
}

function sseResponse(events: ReadonlyArray<SseChunk | "[DONE]">): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockFetch(events: ReadonlyArray<SseChunk | "[DONE]">): typeof fetch {
	const fn = async (): Promise<Response> => sseResponse(events);
	return Object.assign(fn, { preconnect: originalFetch.preconnect });
}

function chunk(content: string | undefined, finish: SseChunk["choices"][0]["finish_reason"] = null): SseChunk {
	return {
		id: "chatcmpl-xml-test",
		object: "chat.completion.chunk",
		created: 0,
		model: "claude-opus-4-8",
		choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finish }],
	};
}

function model(): Model<"openai-completions"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude via relay",
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "http://127.0.0.1:4000/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		compat: { healToolCallXml: true },
	};
}

function context(): Context {
	return { messages: [{ role: "user", content: "ask me", timestamp: Date.now() }] };
}

const FULL =
	'<invoke name="proxy_ask">' +
	'<parameter name="_i">why</parameter>' +
	'<parameter name="questions">[{"id":"r3"}]</parameter>' +
	"</invoke>";

describe("chat-completions: leaked Anthropic tool-call XML healing", () => {
	it("strips XML and synthesizes the tool call, promoting stop -> toolUse", async () => {
		global.fetch = mockFetch([chunk("Sure. "), chunk(FULL), chunk(undefined, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text.trim()).toBe("Sure.");
		expect(text).not.toContain("<invoke");

		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("proxy_ask");
		expect(tools[0].arguments).toEqual({ _i: "why", questions: [{ id: "r3" }] });
		expect(result.stopReason).toBe("toolUse");
	});

	it("reconstructs across a token split mid-tag", async () => {
		const split = FULL.indexOf('name="questions"') + 5;
		global.fetch = mockFetch([
			chunk(FULL.slice(0, split)),
			chunk(FULL.slice(split)),
			chunk(undefined, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model(), context(), { apiKey: "test" }).result();
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].arguments).toEqual({ _i: "why", questions: [{ id: "r3" }] });
	});
});
