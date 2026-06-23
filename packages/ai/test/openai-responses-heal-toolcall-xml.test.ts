import { describe, expect, test } from "bun:test";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, ToolCall } from "@gajae-code/ai/types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

// End-to-end coverage for the Anthropic tool-call-XML healer wired into the
// Responses provider: a Claude model fronted by an OpenAI-compatible relay
// leaks `<invoke name="…"><parameter …>` into `output_text` instead of emitting
// a structured function call. The healer must strip it from visible text AND
// reconstruct the structured call so UI-bound tools (proxy_ask) still fire.

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

function makeModel(healToolCallXml = true): Model<"openai-responses"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude via relay",
		api: "openai-responses",
		provider: "litellm",
		baseUrl: "http://127.0.0.1:4000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		compat: { healToolCallXml },
	};
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "litellm",
		model: "claude-opus-4-8",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function makeCapture() {
	const emitted: Array<Record<string, unknown>> = [];
	const stream = { push: (e: Record<string, unknown>) => emitted.push(e), end: () => {} } as never;
	return { emitted, stream };
}

function textOf(output: AssistantMessage): string {
	return output.content
		.filter(b => b.type === "text")
		.map(b => (b as { text: string }).text)
		.join("");
}

function toolBlocks(output: AssistantMessage): ToolCall[] {
	return output.content.filter(b => b.type === "toolCall") as ToolCall[];
}

/** Build a message stream whose output_text is delivered as the given delta chunks. */
function messageStream(deltas: string[], fullText: string): unknown[] {
	return [
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", content: [] } },
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		...deltas.map(delta => ({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta })),
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: fullText, annotations: [] }],
			},
		},
		{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: undefined } },
	];
}

const FULL =
	"Let me ask you. " +
	"<function_calls>" +
	'<invoke name="proxy_ask">' +
	'<parameter name="_i">why now</parameter>' +
	'<parameter name="questions">[{"id":"r3","question":"how?"}]</parameter>' +
	"</invoke>" +
	"</function_calls>";

describe("Responses provider: leaked Anthropic tool-call XML healing", () => {
	test("strips the XML and reconstructs the tool call (single delta)", async () => {
		const output = makeOutput();
		const { emitted, stream } = makeCapture();
		await processResponsesStream(makeStream(messageStream([FULL], FULL)), output, stream, makeModel());

		expect(textOf(output).trim()).toBe("Let me ask you.");
		expect(textOf(output)).not.toContain("<invoke");

		const tools = toolBlocks(output);
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("proxy_ask");
		expect(tools[0].arguments).toEqual({ _i: "why now", questions: [{ id: "r3", question: "how?" }] });

		// A leaked-XML turn reports status "completed"; promote so the call dispatches.
		expect(output.stopReason).toBe("toolUse");

		const ends = emitted.filter(e => e.type === "toolcall_end");
		expect(ends).toHaveLength(1);
		// Streamed text never contained raw markers.
		const textDeltas = emitted.filter(e => e.type === "text_delta").map(e => e.delta as string);
		expect(textDeltas.join("")).not.toContain("<invoke");
	});

	test("reconstructs the call when the XML is split across many deltas", async () => {
		// One char per delta — forces partial-tag holdback at every boundary.
		const deltas = [...FULL];
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(messageStream(deltas, FULL)), output, stream, makeModel());

		expect(textOf(output).trim()).toBe("Let me ask you.");
		expect(textOf(output)).not.toContain("<");
		const tools = toolBlocks(output);
		expect(tools).toHaveLength(1);
		expect(tools[0].arguments).toEqual({ _i: "why now", questions: [{ id: "r3", question: "how?" }] });
		expect(output.stopReason).toBe("toolUse");
	});

	test("leaves text untouched when healing is disabled for the model", async () => {
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(messageStream([FULL], FULL)), output, stream, makeModel(false));

		// Disabled → raw text passes through, no synthesized tool call.
		expect(textOf(output)).toContain("<invoke");
		expect(toolBlocks(output)).toHaveLength(0);
	});

	test("does not disturb a normal message with no tool-call XML", async () => {
		const prose = "Here is a plain answer with a < b math and no tools.";
		const output = makeOutput();
		const { stream } = makeCapture();
		await processResponsesStream(makeStream(messageStream([prose], prose)), output, stream, makeModel());

		expect(textOf(output)).toBe(prose);
		expect(toolBlocks(output)).toHaveLength(0);
		expect(output.stopReason).toBe("stop");
	});
});
