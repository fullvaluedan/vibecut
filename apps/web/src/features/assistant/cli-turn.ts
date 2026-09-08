/**
 * Pure helpers for the assistant route's CLI modes (claude-code / codex):
 * the schema-constrained turn contract rendered as one prompt, and the CLI's
 * JSON reply normalized into the shared AssistantTurnResponse shape.
 *
 * Kept SEPARATE from the route (and from hf-bridge) so the route test can
 * mock the LLM call seam without stubbing the shared hf-bridge module — Bun
 * runs all test files in one process, and a mock.module on hf-bridge would
 * leak into the Director route suites (see HANDOFF §6).
 */

import {
	ASSISTANT_EDIT_PROMPT_VERSION,
} from "@/features/assistant/prompt";
import { ASSISTANT_EDIT_TOOLS } from "@/features/assistant/tools";
import type {
	AssistantMessage,
	AssistantToolName,
	AssistantToolResult,
	AssistantTurnResponse,
	ToolCall,
} from "@/features/assistant/types";

/** History window sent upstream; mirrors the api-key path's MAX_HISTORY_MESSAGES. */
export const CLI_MAX_HISTORY_MESSAGES = 20;

export const CLI_TURN_SCHEMA = {
	type: "object",
	properties: {
		text: { type: "string" },
		toolCalls: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: {
						type: "string",
						enum: ASSISTANT_EDIT_TOOLS.map((tool) => tool.name),
					},
					args: { type: "object", additionalProperties: true },
				},
				required: ["name"],
				additionalProperties: false,
			},
		},
	},
	required: ["text", "toolCalls"],
	additionalProperties: false,
} as const;

/** Model label for CLI-mode turns (informational; the CLI picks its own). */
export const CLI_TURN_MODEL_LABEL = "cli-assistant";

/** Turn the turn contract's history into one plain-text prompt. */
export function buildCliTurnPrompt({
	systemPrompt,
	messages,
	toolResults,
}: {
	systemPrompt: string;
	messages: AssistantMessage[];
	toolResults: AssistantToolResult[];
}): string {
	const toolLines = ASSISTANT_EDIT_TOOLS.map(
		(tool) => `- ${tool.name}: ${tool.description}`,
	).join("\n");
	const transcript = messages
		.slice(-CLI_MAX_HISTORY_MESSAGES)
		.map((message) => {
			const calls = (message.toolCalls ?? [])
				.map((call) => `[calls ${call.name} ${JSON.stringify(call.args)}]`)
				.join(" ");
			return `${message.role.toUpperCase()}: ${message.content}${calls ? ` ${calls}` : ""}`;
		})
		.join("\n");
	const results = toolResults.length
		? `\nTOOL RESULTS (from your previous turn's calls):\n${toolResults
				.map(
					(result) =>
						`- ${result.toolCallId}: ${result.ok ? "OK" : "FAILED"} — ${result.summary || (result.ok ? "Done." : "Could not be applied.")}`,
				)
				.join("\n")}\n`
		: "";
	return [
		systemPrompt,
		"",
		"AVAILABLE TOOLS (call at most 8 per turn; emit ask_user with a short `question` and optional `options` when you need a decision):",
		toolLines,
		results,
		"CONVERSATION:",
		transcript || "(empty)",
		"",
		'Respond with ONLY the JSON object: {"text": <one short plain-language summary>, "toolCalls": [{"name": <tool name>, "args": <object>}, ...]}. Use [] when no tool is needed.',
	].join("\n");
}

/** Normalize one CLI JSON turn into the shared response shape. */
export function parseCliTurn({
	raw,
	model = CLI_TURN_MODEL_LABEL,
}: {
	raw: unknown;
	model?: string;
}): AssistantTurnResponse {
	const obj =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	const text = typeof obj.text === "string" ? obj.text : "";
	const toolCalls: ToolCall[] = Array.isArray(obj.toolCalls)
		? obj.toolCalls.flatMap((entry, index) => {
				if (typeof entry !== "object" || entry === null) return [];
				const it = entry as Record<string, unknown>;
				if (typeof it.name !== "string") return [];
				return [
					{
						id: `cli-${index}-${it.name}`,
						name: it.name as AssistantToolName,
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
		stopReason: toolCalls.length ? "tool_use" : "end_turn",
		usage: null,
		promptVersion: ASSISTANT_EDIT_PROMPT_VERSION,
		model,
	};
}
