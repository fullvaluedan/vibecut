import { describe, expect, test } from "bun:test";

import {
	buildAssistantFallbackPrompt,
	parseAssistantFallbackTurn,
} from "../fallback-turn";
import { toAnthropicTools } from "../tools";
import { buildAssistantEditSystemPrompt } from "../prompt";
import type { AssistantContext } from "../context";

const context = {
	version: 1,
	tracks: [
		{
			label: "V1",
			type: "video",
			main: true,
			clipCount: 1,
			clips: [
				{
					id: "clip-intro",
					track: "V1",
					name: "intro.mp4",
					kind: "video",
					startSec: 0,
					endSec: 6,
				},
			],
		},
	],
} as unknown as AssistantContext;

describe("buildAssistantFallbackPrompt", () => {
	const system = buildAssistantEditSystemPrompt({ context });

	test("carries the system prompt, the tool catalog, and the history", () => {
		const prompt = buildAssistantFallbackPrompt({
			system,
			messages: [
				{ role: "user", content: "delete the intro" },
				{
					role: "assistant",
					content: "Removing it.",
					toolCalls: [
						{ id: "call-1", name: "delete_clip", args: { clipId: "clip-intro" } },
					],
				},
			],
			toolResults: [],
			tools: toAnthropicTools(),
		});
		expect(prompt).toContain("edit operator for VibeCut");
		expect(prompt).toContain("clip-intro");
		expect(prompt).toContain("TOOL CATALOG");
		expect(prompt).toContain("ask_user");
		expect(prompt).toContain("delete_clip");
		expect(prompt).toContain("USER: delete the intro");
		expect(prompt).toContain("[tool call call-1] delete_clip");
		// The output contract is spelled out for a model with no native tools.
		expect(prompt).toContain("ONLY a JSON object");
	});

	test("renders tool results with their ok/failed state", () => {
		const prompt = buildAssistantFallbackPrompt({
			system,
			messages: [{ role: "user", content: "delete the intro" }],
			toolResults: [
				{ toolCallId: "call-1", ok: true, summary: "Deleted intro.mp4." },
				{ toolCallId: "call-2", ok: false, summary: "No more footage." },
			],
			tools: toAnthropicTools(),
		});
		expect(prompt).toContain("TOOL RESULTS");
		expect(prompt).toContain("- call-1: ok - Deleted intro.mp4.");
		expect(prompt).toContain("- call-2: FAILED - No more footage.");
	});

	test("windows the history to the most recent 20 messages", () => {
		const messages = Array.from({ length: 30 }, (_, i) => ({
			role: "user" as const,
			content: `message-${i}`,
		}));
		const prompt = buildAssistantFallbackPrompt({
			system,
			messages,
			toolResults: [],
			tools: toAnthropicTools(),
		});
		expect(prompt).not.toContain("message-9");
		expect(prompt).toContain("message-10");
		expect(prompt).toContain("message-29");
	});
});

describe("parseAssistantFallbackTurn", () => {
	test("reads text + tool calls into the turn contract", () => {
		const turn = parseAssistantFallbackTurn({
			raw: {
				text: "Removing the intro.",
				toolCalls: [
					{ id: "call-1", name: "delete_clip", args: { clipId: "clip-intro" } },
				],
			},
			model: "claude-code",
			usage: { inputTokens: 9, outputTokens: 4 },
		});
		expect(turn.text).toBe("Removing the intro.");
		expect(turn.toolCalls).toEqual([
			{ id: "call-1", name: "delete_clip", args: { clipId: "clip-intro" } },
		]);
		expect(turn.question).toBeNull();
		expect(turn.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
		expect(turn.promptVersion).toBe(1);
		expect(turn.model).toBe("claude-code");
	});

	test("extracts an ask_user question with options", () => {
		const turn = parseAssistantFallbackTurn({
			raw: {
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "ask_user",
						args: { question: "Intro or body?", options: ["intro", "body"] },
					},
				],
			},
			model: "gpt-test",
			usage: null,
		});
		expect(turn.question).toBe("Intro or body?");
		expect(turn.questionOptions).toEqual(["intro", "body"]);
		expect(turn.toolCalls).toHaveLength(1);
	});

	test("drops malformed call entries instead of throwing", () => {
		const turn = parseAssistantFallbackTurn({
			raw: {
				text: "hi",
				toolCalls: [
					{ name: "delete_clip" }, // no id
					"garbage",
					{ id: "call-2", name: "extend_clip", args: "not-an-object" },
				],
			},
			model: "m",
			usage: null,
		});
		expect(turn.toolCalls).toEqual([
			{ id: "call-2", name: "extend_clip", args: {} },
		]);
	});

	test("a missing text/toolCalls pair still produces a valid empty turn", () => {
		const turn = parseAssistantFallbackTurn({
			raw: {},
			model: "m",
			usage: null,
		});
		expect(turn.text).toBe("");
		expect(turn.toolCalls).toEqual([]);
		expect(turn.question).toBeNull();
	});
});
