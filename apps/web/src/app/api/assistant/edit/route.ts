/**
 * POST /api/assistant/edit - one turn of the prompt-to-edit assistant (T17.1).
 *
 * WHY A NEW ROUTE INSTEAD OF EXTENDING /api/assistant. The existing assistant
 * route is a single-shot COMMAND ROUTER: one prompt in, exactly one flat
 * `AssistantCommand` out, schema-constrained, no history, no tools. Its response
 * type is imported by `features/assistant/run-assistant.ts` and drives a switch
 * there. The edit assistant is a different animal: a multi-turn conversation
 * with tool calls, tool results, and a clarifying-question path. Folding both
 * into one handler would mean a mode flag, two incompatible response shapes, and
 * a breaking change to a shipped surface for zero gain. They also diverge in
 * provider requirements (see below). So: sibling route, shared auth plumbing,
 * the old route untouched.
 *
 * PROVIDER. Auth resolves through the same `resolveAiAuth` header plumbing every
 * other AI route uses. Tool use needs the native tools API, which the claude-code
 * CLI path and the OpenAI-compatible custom path do not expose in the shape this
 * turn contract needs, so this route requires an Anthropic API key (device-local
 * header, or a server-side `ANTHROPIC_API_KEY` for a hosted deployment) and says
 * so plainly otherwise. Round 21's T21.2 provider abstraction is where the other
 * backends get wired in; doing it here would be guesswork ahead of that plan.
 *
 * Non-streaming by design for v1 (the roadmap allows it). The response is one
 * `AssistantTurnResponse`; T17.2 validates its tool calls and executes them.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";
import {
	ASSISTANT_EDIT_MODEL,
	ASSISTANT_EDIT_PROMPT_VERSION,
	buildAssistantEditSystemPrompt,
} from "@/features/assistant/prompt";
import { toAnthropicTools } from "@/features/assistant/tools";
import type { AssistantContext } from "@/features/assistant/context";
import type {
	AssistantMessage,
	AssistantToolResult,
	AssistantTurnResponse,
	ToolCall,
} from "@/features/assistant/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 2000;
/** Conversation window sent upstream; older turns fall off the front. */
const MAX_HISTORY_MESSAGES = 20;

type AnthropicBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicBlock[];
}

function parseMessages(raw: unknown): AssistantMessage[] | null {
	if (!Array.isArray(raw)) return null;
	const out: AssistantMessage[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const message = entry as Record<string, unknown>;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content = typeof message.content === "string" ? message.content : "";
		const toolCalls = Array.isArray(message.toolCalls)
			? (message.toolCalls as unknown[]).flatMap((call) => {
					if (typeof call !== "object" || call === null) return [];
					const it = call as Record<string, unknown>;
					if (typeof it.id !== "string" || typeof it.name !== "string") return [];
					return [
						{
							id: it.id,
							name: it.name,
							args:
								typeof it.args === "object" && it.args !== null && !Array.isArray(it.args)
									? (it.args as Record<string, unknown>)
									: {},
						} satisfies ToolCall,
					];
				})
			: [];
		if (!content && toolCalls.length === 0) continue;
		out.push({
			role: message.role,
			content,
			...(toolCalls.length ? { toolCalls } : {}),
		});
	}
	return out;
}

function parseToolResults(raw: unknown): AssistantToolResult[] {
	if (!Array.isArray(raw)) return [];
	const out: AssistantToolResult[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it = entry as Record<string, unknown>;
		if (typeof it.toolCallId !== "string") continue;
		out.push({
			toolCallId: it.toolCallId,
			ok: it.ok === true,
			summary: typeof it.summary === "string" ? it.summary : "",
		});
	}
	return out;
}

/** Turn the turn contract's history into the provider's block format. */
export function buildAnthropicMessages({
	messages,
	toolResults,
}: {
	messages: AssistantMessage[];
	toolResults: AssistantToolResult[];
}): AnthropicMessage[] {
	const windowed = messages.slice(-MAX_HISTORY_MESSAGES);
	const out: AnthropicMessage[] = windowed.map((message) => {
		const blocks: AnthropicBlock[] = [];
		if (message.content) blocks.push({ type: "text", text: message.content });
		for (const call of message.toolCalls ?? []) {
			blocks.push({
				type: "tool_use",
				id: call.id,
				name: call.name,
				input: call.args,
			});
		}
		return { role: message.role, content: blocks };
	});
	if (toolResults.length) {
		out.push({
			role: "user",
			content: toolResults.map((result) => ({
				type: "tool_result" as const,
				tool_use_id: result.toolCallId,
				content: result.summary || (result.ok ? "Done." : "Could not be applied."),
				...(result.ok ? {} : { is_error: true }),
			})),
		});
	}
	return out;
}

interface AnthropicResponseBody {
	content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
	stop_reason?: string | null;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** Read the provider's reply into the turn contract's response shape. */
export function parseAnthropicTurn({
	data,
	model,
}: {
	data: AnthropicResponseBody;
	model: string;
}): AssistantTurnResponse {
	const texts: string[] = [];
	const toolCalls: ToolCall[] = [];
	for (const block of data.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			texts.push(block.text);
			continue;
		}
		if (block.type === "tool_use" && block.id && block.name) {
			toolCalls.push({
				id: block.id,
				name: block.name,
				args:
					typeof block.input === "object" &&
					block.input !== null &&
					!Array.isArray(block.input)
						? (block.input as Record<string, unknown>)
						: {},
			});
		}
	}
	const ask = toolCalls.find((call) => call.name === "ask_user");
	const question =
		ask && typeof ask.args.question === "string" ? ask.args.question : null;
	const rawOptions = ask?.args.options;
	const questionOptions = Array.isArray(rawOptions)
		? rawOptions.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	return {
		text: texts.join("\n").trim(),
		toolCalls,
		question,
		...(questionOptions && questionOptions.length
			? { questionOptions }
			: {}),
		stopReason: data.stop_reason ?? null,
		usage: data.usage
			? {
					inputTokens: data.usage.input_tokens ?? 0,
					outputTokens: data.usage.output_tokens ?? 0,
				}
			: null,
		promptVersion: ASSISTANT_EDIT_PROMPT_VERSION,
		model,
	};
}

export async function POST(req: NextRequest) {
	const auth = resolveAiAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "Your AI connection isn't fully configured. Check Settings → AI." },
			{ status: 401 },
		);
	}
	const apiKey =
		auth.mode === "api-key" ? auth.apiKey : process.env.ANTHROPIC_API_KEY || "";
	if (!apiKey) {
		return NextResponse.json(
			{
				error:
					"Prompt-to-edit needs an Anthropic API key. Add one in Settings → AI (the editing tools use Anthropic's tool calling, which the other connection modes do not offer yet).",
			},
			{ status: 400 },
		);
	}

	const body = await req.json().catch(() => null);
	const context = body?.context as AssistantContext | undefined;
	if (!context || typeof context !== "object" || !Array.isArray(context.tracks)) {
		return NextResponse.json(
			{ error: "Missing or malformed timeline context" },
			{ status: 400 },
		);
	}
	const messages = parseMessages(body?.messages);
	if (!messages || messages.length === 0) {
		return NextResponse.json(
			{ error: "Missing or empty messages" },
			{ status: 400 },
		);
	}
	const toolResults = parseToolResults(body?.toolResults);
	const model =
		typeof body?.model === "string" && body.model.trim()
			? body.model.trim()
			: ASSISTANT_EDIT_MODEL;

	try {
		const res = await fetch(ANTHROPIC_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			body: JSON.stringify({
				model,
				max_tokens: MAX_OUTPUT_TOKENS,
				system: buildAssistantEditSystemPrompt({ context }),
				tools: toAnthropicTools(),
				messages: buildAnthropicMessages({ messages, toolResults }),
			}),
		});
		if (!res.ok) {
			const detail = await res.text();
			return NextResponse.json(
				{
					error: `The assistant could not be reached (${res.status}): ${detail.slice(0, 300)}`,
				},
				{ status: res.status === 401 ? 401 : 502 },
			);
		}
		const data = (await res.json()) as AnthropicResponseBody;
		return NextResponse.json(parseAnthropicTurn({ data, model }));
	} catch (e) {
		return NextResponse.json(
			{
				error: `Assistant edit failed: ${e instanceof Error ? e.message : String(e)}`,
			},
			{ status: 500 },
		);
	}
}
