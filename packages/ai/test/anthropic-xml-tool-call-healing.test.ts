import { describe, expect, it } from "bun:test";
import {
	AnthropicXmlToolCallHealer,
	modelMayLeakAnthropicXmlToolCalls,
} from "../src/utils/anthropic-xml-tool-call-healing";

/** Feed an entire string in one chunk and return {text, calls}. */
function healOnce(input: string) {
	const healer = new AnthropicXmlToolCallHealer();
	const text = healer.feed(input) + healer.flushPending();
	return { text, calls: healer.drainCompleted() };
}

/** Feed char-by-char to exercise partial-tag holdback at every boundary. */
function healByChar(input: string) {
	const healer = new AnthropicXmlToolCallHealer();
	let text = "";
	const calls: ReturnType<AnthropicXmlToolCallHealer["drainCompleted"]> = [];
	for (const ch of input) {
		text += healer.feed(ch);
		calls.push(...healer.drainCompleted());
	}
	text += healer.flushPending();
	calls.push(...healer.drainCompleted());
	return { text, calls };
}

describe("AnthropicXmlToolCallHealer", () => {
	const FULL =
		"<function_calls>\n" +
		'<invoke name="proxy_ask">\n' +
		'<parameter name="_i">why now</parameter>\n' +
		'<parameter name="questions">[{"id":"r3","q":"how?"}]</parameter>\n' +
		"</invoke>\n" +
		"</function_calls>";

	it("strips a complete block and reconstructs the tool call", () => {
		const { text, calls } = healOnce(`I'll ask. ${FULL}`);
		expect(text.trim()).toBe("I'll ask.");
		expect(text).not.toContain("<invoke");
		expect(text).not.toContain("<parameter");
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("proxy_ask");
		expect(calls[0].id).toMatch(/^call_[0-9a-f]+$/);
		expect(JSON.parse(calls[0].arguments)).toEqual({
			_i: "why now",
			questions: [{ id: "r3", q: "how?" }],
		});
	});

	it("works without a <function_calls> wrapper (bare invoke)", () => {
		const bare = '<invoke name="ask"><parameter name="x">1</parameter></invoke>';
		const { text, calls } = healOnce(`before ${bare} after`);
		expect(text).toBe("before  after");
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("ask");
		expect(JSON.parse(calls[0].arguments)).toEqual({ x: 1 });
	});

	it("tolerates the antml: namespace prefix", () => {
		const ns =
			"<function_calls>" +
			'<invoke name="ask">' +
			'<parameter name="p">"v"</parameter>' +
			"</invoke>" +
			"</function_calls>";
		const { text, calls } = healOnce(ns);
		expect(text).toBe("");
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("ask");
		expect(JSON.parse(calls[0].arguments)).toEqual({ p: "v" });
	});

	it("reconstructs a block split across every character boundary", () => {
		const { text, calls } = healByChar(`ok ${FULL} done`);
		expect(text.replace(/\s+/g, " ").trim()).toBe("ok done");
		expect(text).not.toContain("<");
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0].arguments)).toEqual({
			_i: "why now",
			questions: [{ id: "r3", q: "how?" }],
		});
	});

	it("preserves a parameter value that contains '<' and '>'", () => {
		const block = '<invoke name="ask"><parameter name="expr">a < b && c > d</parameter></invoke>';
		const { calls } = healOnce(block);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0].arguments)).toEqual({ expr: "a < b && c > d" });
	});

	it("coerces typed parameter values; keeps plain strings verbatim", () => {
		const block =
			'<invoke name="t">' +
			'<parameter name="n">42</parameter>' +
			'<parameter name="b">true</parameter>' +
			'<parameter name="s">hello world</parameter>' +
			'<parameter name="o">{"k":1}</parameter>' +
			"</invoke>";
		const { calls } = healOnce(block);
		expect(JSON.parse(calls[0].arguments)).toEqual({
			n: 42,
			b: true,
			s: "hello world",
			o: { k: 1 },
		});
	});

	it("handles multiple invokes inside one function_calls section", () => {
		const block =
			"<function_calls>" +
			'<invoke name="a"><parameter name="x">1</parameter></invoke>' +
			'<invoke name="b"><parameter name="y">2</parameter></invoke>' +
			"</function_calls>";
		const { calls } = healOnce(block);
		expect(calls.map(c => c.name)).toEqual(["a", "b"]);
		expect(calls[0].id).not.toBe(calls[1].id);
		expect(JSON.parse(calls[1].arguments)).toEqual({ y: 2 });
	});

	it("passes prose through unchanged when no markers are present", () => {
		const { text, calls } = healOnce("Just normal text with a < b comparison.");
		expect(text).toBe("Just normal text with a < b comparison.");
		expect(calls).toHaveLength(0);
	});

	it("does not eat a stray '<' that cannot start a tag", () => {
		const { text, calls } = healByChar("price < 5 and x<y");
		expect(text).toBe("price < 5 and x<y");
		expect(calls).toHaveLength(0);
	});

	it("drops an unterminated invoke at stream end (no raw XML leaks)", () => {
		const { text, calls } = healOnce('thinking… <invoke name="ask"><parameter name="x">1');
		expect(text.trim()).toBe("thinking…");
		expect(text).not.toContain("<invoke");
		expect(calls).toHaveLength(0);
	});

	it("emits an empty-args call for an invoke with no parameters", () => {
		const { calls } = healOnce('<invoke name="ping"></invoke>');
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toBe("{}");
	});
});

describe("modelMayLeakAnthropicXmlToolCalls", () => {
	it("honors the explicit compat opt-in/out first", () => {
		expect(
			modelMayLeakAnthropicXmlToolCalls({ provider: "litellm", modelId: "gpt-5.5", healToolCallXml: true }),
		).toBe(true);
		expect(
			modelMayLeakAnthropicXmlToolCalls({
				provider: "anthropic",
				modelId: "claude-opus-4-8",
				healToolCallXml: false,
			}),
		).toBe(false);
	});

	it("treats claude-family ids/providers as candidates by default", () => {
		expect(modelMayLeakAnthropicXmlToolCalls({ provider: "litellm", modelId: "claude-opus-4-8" })).toBe(true);
		expect(modelMayLeakAnthropicXmlToolCalls({ provider: "openrouter", modelId: "gpt-5.5" })).toBe(false);
	});
});
