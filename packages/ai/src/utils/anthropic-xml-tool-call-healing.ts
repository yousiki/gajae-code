/**
 * Streaming-safe filter for Anthropic-style tool-call XML that leaks into
 * visible assistant text.
 *
 * Claude models are trained to request tools with an XML grammar:
 *
 *     <function_calls>
 *       <invoke name="proxy_ask">
 *         <parameter name="_i">why now</parameter>
 *         <parameter name="questions">[{"id":"r3", ...}]</parameter>
 *       </invoke>
 *     </function_calls>
 *
 * When a Claude model is served through a relay that forwards the raw model
 * text instead of converting it into structured `tool_calls` (common with
 * LiteLLM / OpenAI-compatible proxies fronting Claude), this grammar lands in
 * `delta.content` / `response.output_text.delta`. The agent loop then never
 * sees a tool call, so UI-bound tools like `proxy_ask` (the deep-interview
 * question panel) silently fail to render — the user just sees the raw XML.
 *
 * This module reconstructs the embedded calls and strips the markers from the
 * visible text. It is stream-aware: any partial tag at the end of a chunk is
 * held back until the next chunk arrives. It mirrors the design of the Kimi-K2
 * {@link ToolCallHealer}, but the grammar carries attributes (`name="…"`) and
 * nests, so the matcher is tag-oriented rather than fixed-token.
 *
 * The `antml:` namespace prefix (used by some harness encodings) and a missing
 * outer `<function_calls>` wrapper are both tolerated: a bare `<invoke …>`
 * opens an implicit section.
 */

import { generateHealedToolCallId, type HealedToolCall } from "./tool-call-healing";

/** Longest partial tag we hold back waiting for more bytes before giving up. */
const MAX_PARTIAL_HOLD = 1024;

/** Literal tag stems we may be in the middle of receiving (no attrs / close yet). */
const TAG_STEMS = [
	"<function_calls",
	"</function_calls",
	"<function_calls",
	"</function_calls",
	"<invoke",
	"</invoke",
	"<invoke",
	"</invoke",
	"<parameter",
	"</parameter",
	"<parameter",
	"</parameter",
] as const;

const RE_FUNCTION_CALLS_OPEN = /^<(?:antml:)?function_calls\s*>/;
const RE_FUNCTION_CALLS_CLOSE = /^<\/(?:antml:)?function_calls\s*>/;
const RE_INVOKE_OPEN = /^<(?:antml:)?invoke\s+name\s*=\s*"([^"]*)"\s*>/;
const RE_INVOKE_CLOSE = /^<\/(?:antml:)?invoke\s*>/;
const RE_PARAMETER_OPEN = /^<(?:antml:)?parameter\s+name\s*=\s*"([^"]*)"\s*>/;
const RE_PARAMETER_CLOSE = /^<\/(?:antml:)?parameter\s*>/;
const RE_PARAMETER_CLOSE_STEMS = ["</parameter", "</parameter"] as const;

type TagMatch =
	| { kind: "functionCallsOpen" | "functionCallsClose" | "invokeClose" | "parameterClose"; length: number }
	| { kind: "invokeOpen" | "parameterOpen"; length: number; name: string };

/**
 * Coerce a raw `<parameter>` body into the JSON value the tool schema expects.
 * Typed params (objects, arrays, numbers, booleans) are written as JSON; plain
 * strings are written verbatim. Try a strict JSON parse first and fall back to
 * the raw (trimmed) string — never repair, so a value that merely *looks*
 * JSON-ish is not silently rewritten.
 */
function coerceParameterValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return "";
	try {
		return JSON.parse(trimmed);
	} catch {
		return raw;
	}
}

/**
 * State machine that consumes streamed text, emits visible text with all
 * Anthropic tool-call XML stripped, and accumulates the embedded calls for the
 * caller to drain after each {@link feed}.
 *
 * One instance per stream. Feed only the visible-text channel (assistant
 * content); never the reasoning channel.
 */
export class AnthropicXmlToolCallHealer {
	#buffer = "";
	#offset = 0;
	#inFunctionCalls = false;
	#invokeName: string | null = null;
	#params: Record<string, unknown> = {};
	#paramName: string | null = null;
	#paramValue = "";
	readonly #completed: HealedToolCall[] = [];

	/**
	 * Feed a chunk of streamed text. Returns the portion safe to emit
	 * downstream (with all tool-call XML stripped). Any partial tag suffix is
	 * held back until the next chunk arrives or {@link flushPending} is called.
	 */
	feed(text: string): string {
		if (text.length === 0) return "";
		this.#compact();
		this.#buffer += text;
		return this.#consume();
	}

	/** Drain accumulated tool calls. The internal list is cleared. */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush any held-back fragment when the stream ends. If we are mid-invoke
	 * the partial is dropped (emitting raw XML bytes would surface markers to
	 * the user); otherwise the fragment is returned verbatim so a literal `<`
	 * in prose is not lost.
	 */
	flushPending(): string {
		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;
		if (this.#invokeName !== null || this.#inFunctionCalls) return "";
		return tail;
	}

	/** True if a `<function_calls>` or `<invoke>` section is currently open. */
	get inSection(): boolean {
		return this.#inFunctionCalls || this.#invokeName !== null;
	}

	#remaining(): string {
		return this.#offset === 0 ? this.#buffer : this.#buffer.slice(this.#offset);
	}

	#compact(): void {
		if (this.#offset === 0) return;
		this.#buffer = this.#buffer.slice(this.#offset);
		this.#offset = 0;
	}

	#consume(): string {
		let clean = "";

		while (this.#offset < this.#buffer.length) {
			// Inside a <parameter> body the only structural token is its close
			// tag; everything else is literal value content.
			if (this.#paramName !== null) {
				if (this.#buffer[this.#offset] === "<") {
					const close = this.#matchParameterClose();
					if (close) {
						this.#finalizeParameter();
						this.#offset += close;
						continue;
					}
					if (this.#couldBePartialParameterClose()) break;
				}
				this.#paramValue += this.#buffer[this.#offset];
				this.#offset += 1;
				continue;
			}

			if (this.#buffer[this.#offset] !== "<") {
				const ch = this.#buffer[this.#offset]!;
				this.#offset += 1;
				// Swallow inter-element whitespace/content inside a section;
				// pass everything through outside one.
				if (!this.inSection) clean += ch;
				continue;
			}

			const tag = this.#matchTag();
			if (tag) {
				clean += this.#applyTag(tag);
				this.#offset += tag.length;
				continue;
			}

			if (this.#couldBePartialTag()) break;

			// A `<` that cannot start any known tag — emit literally.
			this.#offset += 1;
			if (!this.inSection) clean += "<";
		}

		return clean;
	}

	/** Apply a fully-matched tag, returning any text it should emit verbatim. */
	#applyTag(tag: TagMatch): string {
		switch (tag.kind) {
			case "functionCallsOpen":
				this.#inFunctionCalls = true;
				return "";
			case "functionCallsClose":
				this.#inFunctionCalls = false;
				return "";
			case "invokeOpen":
				this.#invokeName = tag.name;
				this.#params = {};
				return "";
			case "invokeClose":
				if (this.#invokeName !== null) this.#finalizeInvoke();
				return "";
			case "parameterOpen":
				if (this.#invokeName !== null) {
					this.#paramName = tag.name;
					this.#paramValue = "";
					return "";
				}
				// Stray `<parameter>` outside an invoke — pass through as text so
				// docs explaining the grammar are not silently eaten.
				return this.#buffer.slice(this.#offset, this.#offset + tag.length);
			case "parameterClose":
				return this.inSection ? "" : this.#buffer.slice(this.#offset, this.#offset + tag.length);
		}
	}

	#matchTag(): TagMatch | null {
		const rest = this.#buffer.slice(this.#offset);
		let m = RE_INVOKE_OPEN.exec(rest);
		if (m) return { kind: "invokeOpen", length: m[0].length, name: m[1] ?? "" };
		m = RE_PARAMETER_OPEN.exec(rest);
		if (m) return { kind: "parameterOpen", length: m[0].length, name: m[1] ?? "" };
		m = RE_INVOKE_CLOSE.exec(rest);
		if (m) return { kind: "invokeClose", length: m[0].length };
		m = RE_PARAMETER_CLOSE.exec(rest);
		if (m) return { kind: "parameterClose", length: m[0].length };
		m = RE_FUNCTION_CALLS_OPEN.exec(rest);
		if (m) return { kind: "functionCallsOpen", length: m[0].length };
		m = RE_FUNCTION_CALLS_CLOSE.exec(rest);
		if (m) return { kind: "functionCallsClose", length: m[0].length };
		return null;
	}

	#matchParameterClose(): number | null {
		const m = RE_PARAMETER_CLOSE.exec(this.#buffer.slice(this.#offset));
		return m ? m[0].length : null;
	}

	/**
	 * True if the unconsumed buffer is a strict prefix of some tag, or an open
	 * tag still streaming its attributes (`<invoke name="foo` with no `>` yet).
	 * Capped so a stray `<` in prose can't grow the holdback unboundedly.
	 */
	#couldBePartialTag(): boolean {
		return this.#couldBePartial(TAG_STEMS);
	}

	#couldBePartialParameterClose(): boolean {
		return this.#couldBePartial(RE_PARAMETER_CLOSE_STEMS);
	}

	#couldBePartial(stems: readonly string[]): boolean {
		const remaining = this.#buffer.length - this.#offset;
		if (remaining === 0 || remaining > MAX_PARTIAL_HOLD) return false;
		const slice = this.#buffer.slice(this.#offset);
		for (const stem of stems) {
			// Case 1: we have less than the stem and it is a prefix of the stem.
			if (slice.length < stem.length && stem.startsWith(slice)) return true;
			// Case 2: we have the full stem but the tag has not closed (`>`) yet,
			// so its attributes may still be streaming.
			if (slice.startsWith(stem) && !slice.includes(">")) return true;
		}
		return false;
	}

	#finalizeParameter(): void {
		if (this.#paramName === null) return;
		this.#params[this.#paramName] = coerceParameterValue(this.#paramValue);
		this.#paramName = null;
		this.#paramValue = "";
	}

	#finalizeInvoke(): void {
		const name = (this.#invokeName ?? "").trim();
		// A `</invoke>` arriving mid-parameter still flushes the captured value.
		if (this.#paramName !== null) this.#finalizeParameter();
		this.#completed.push({
			id: generateHealedToolCallId(),
			name,
			arguments: JSON.stringify(this.#params),
		});
		this.#invokeName = null;
		this.#params = {};
	}
}

/**
 * Whether a provider/model may leak Anthropic tool-call XML into visible text.
 *
 * The leak is relay-specific, not model-id detectable (a proxy may surface a
 * Claude model under an arbitrary id), so the primary switch is an explicit
 * provider `compat.healToolCallXml` opt-in. Claude-family ids served through an
 * OpenAI-compatible API (where structured tool calls would otherwise be
 * expected) are also treated as candidates.
 */
export function modelMayLeakAnthropicXmlToolCalls(opts: {
	provider: string;
	modelId: string;
	healToolCallXml?: boolean;
}): boolean {
	if (opts.healToolCallXml === true) return true;
	if (opts.healToolCallXml === false) return false;
	return /claude|anthropic/i.test(opts.modelId) || /anthropic/i.test(opts.provider);
}

export type { HealedToolCall };
