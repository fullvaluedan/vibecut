/**
 * The non-Anthropic assistant edit turn (T21.2): prompt-instructed tool-call
 * JSON instead of Anthropic's native tools API.
 *
 * WHY. The edit route's turn contract (tools + multi-turn history) is natively
 * expressible only on the Anthropic Messages API. Every other provider tier in
 * the T21.2 capability model has `tools: false`, so for those modes the route
 * flattens the whole turn - system prompt, tool catalog, windowed history,
 * tool results - into ONE prompt, instructs the model to answer with a JSON
 * object, and parses that back into the same `AssistantTurnResponse` the
 * client-side execution loop (turn-service.ts) already consumes. That loop is
 * what actually validates and applies the edits, so the safety spine is
 * identical on every provider.
 *
 * This is also what unlocks claude-code mode for the assistant: the CLI is a
 * single text-in/text-out call, exactly the shape this fallback needs.
 *
 * The hf-bridge import is lazy: route tests stub THIS module (never the
 * bridge), and a top-level bridge import would resolve against whichever
 * process-global mock another route test registered first.
 */

import type { ClaudeAuth } from "@framecut/hf-bridge";
import type { AnthropicToolSpec } from "./tools";
import type {
	AssistantMessage,
	AssistantToolResult,
	AssistantTurnResponse,
	ToolCall,
} from "./types";
import { ASSISTANT_EDIT_PROMPT_VERSION } from "./prompt";

/** Conversation window folded into the fallback prompt (mirrors the route). */
const MAX_HISTORY_MESSAGES = 20;

/** The JSON shape the fallback instructs the model to answer with. */
const ASSISTANT_TURN_FALLBACK_SCHEMA = {
	type: "object",
	properties: {
		text: { type: "string" },
		toolCalls: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					name: { type: "string" },
					args: { type: "object", additionalProperties: true },
				},
				required: ["id", "name", "args"],
				additionalProperties: false,
			},
		},
	},
	required: ["text"],
	additionalProperties: false,
} as const;

function renderHistory(messages: AssistantMessage[]): string {
	const windowed = messages.slice(-MAX_HISTORY_MESSAGES);
	return windowed
		.map((message) => {
			const calls = (message.toolCalls ?? [])
				.map(
					(call) =>
						`  [tool call ${call.id}] ${call.name}(${JSON.stringify(call.args)})`,
				)
				.join("\n");
			const head = `${message.role.toUpperCase()}: ${message.content}`.trimEnd();
			return calls ? `${head}\n${calls}` : head;
		})
		.join("\n");
}

/**
 * Flatten one assistant turn into a single prompt for providers without
 * native tools. Pure, so the shape is unit-testable.
 */
export function buildAssistantFallbackPrompt({
	system,
	messages,
	toolResults,
	tools,
}: {
	system: string;
	messages: AssistantMessage[];
	toolResults: AssistantToolResult[];
	tools: AnthropicToolSpec[];
}): string {
	const toolCatalog = tools
		.map(
			(tool) =>
				`- ${tool.name}: ${tool.description}\n  args schema: ${JSON.stringify(tool.input_schema)}`,
		)
		.join("\n");
	const resultsBlock = toolResults.length
		? `\nTOOL RESULTS (the editor already ran these calls; summarize the outcome for the user, do not call more tools unless something failed and needs one different retry):\n${toolResults
				.map(
					(result) =>
						`- ${result.toolCallId}: ${result.ok ? "ok" : "FAILED"} - ${result.summary}`,
				)
				.join("\n")}\n`
		: "";
	return `${system}

TOOL CATALOG (you call tools ONLY by naming them in your JSON reply):
${toolCatalog}

CONVERSATION (oldest first):
${renderHistory(messages)}
${resultsBlock}
HOW TO REPLY - with ONLY a JSON object, no markdown fences, no prose around it:
{"text": "what you are doing, in the user's own words", "toolCalls": [{"id": "call-1", "name": "tool_name", "args": {...}}]}
Rules:
- "toolCalls" may be omitted or empty when you are only answering, summarizing tool results, or asking nothing.
- To ask the user a clarifying question, call ask_user with a "question" arg (and optional "options" array).
- Use fresh unique ids (call-1, call-2, ...). Every "name" must come from the TOOL CATALOG; "args" must satisfy its schema.`;
}

/**
 * Read the model's JSON reply into the turn contract. Tolerates prose around
 * the object and malformed call entries (dropped, never thrown) - the client
 * loop is the strict validator, so a lossy read here costs at worst one retry.
 */
export function parseAssistantFallbackTurn({
	raw,
	model,
	usage,
}: {
	raw: unknown;
	model: string;
	usage: { inputTokens: number; outputTokens: number } | null;
}): AssistantTurnResponse {
	const obj = (raw ?? {}) as Record<string, unknown>;
	const text = typeof obj.text === "string" ? obj.text.trim() : "";
	const toolCalls: ToolCall[] = Array.isArray(obj.toolCalls)
		? obj.toolCalls.flatMap((entry) => {
				if (typeof entry !== "object" || entry === null) return [];
				const it = entry as Record<string, unknown>;
				if (typeof it.id !== "string" || typeof it.name !== "string") return [];
				return [
					{
						id: it.id,
						name: it.name,
						args:
							typeof it.args === "object" &&
							it.args !== null &&
							!Array.isArray(it.args)
								? (it.args as Record<string, unknown>)
								: {},
					} satisfies ToolCall,
				];
			})
		: [];
	const ask = toolCalls.find((call) => call.name === "ask_user");
	const question =
		ask && typeof ask.args.question === "string" ? ask.args.question : null;
	const rawOptions = ask?.args.options;
	const questionOptions = Array.isArray(rawOptions)
		? rawOptions.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	return {
		text,
		toolCalls,
		question,
		...(questionOptions && questionOptions.length ? { questionOptions } : {}),
		stopReason: null,
		usage,
		promptVersion: ASSISTANT_EDIT_PROMPT_VERSION,
		model,
	};
}

/**
 * Run one assistant edit turn on a provider without native tool support
 * (claude-code, custom, openai, xai-grok, groq-llm) via hf-bridge's shared
 * JSON dispatch. `model` overrides the provider's default when set.
 */
export async function runAssistantFallbackTurn({
	auth,
	system,
	messages,
	toolResults,
	tools,
	model,
}: {
	auth: Exclude<ClaudeAuth, { mode: "api-key" }>;
	system: string;
	messages: AssistantMessage[];
	toolResults: AssistantToolResult[];
	tools: AnthropicToolSpec[];
	model?: string;
}): Promise<AssistantTurnResponse> {
	const { planJson, OPENAI_COMPATIBLE_PROVIDERS } = await import(
		"@framecut/hf-bridge"
	);
	const prompt = buildAssistantFallbackPrompt({
		system,
		messages,
		toolResults,
		tools,
	});
	const effectiveAuth =
		model && auth.mode !== "claude-code"
			? ({ ...auth, model } as typeof auth)
			: auth;
	const { raw, usage } = await planJson({
		prompt,
		auth: effectiveAuth,
		schema: ASSISTANT_TURN_FALLBACK_SCHEMA,
	});
	const providerModel =
		auth.mode === "custom"
			? auth.model
			: auth.mode === "claude-code"
				? "claude-code"
				: (auth.model ?? OPENAI_COMPATIBLE_PROVIDERS[auth.mode].defaultModel);
	return parseAssistantFallbackTurn({
		raw,
		model: model ?? providerModel,
		usage,
	});
}
