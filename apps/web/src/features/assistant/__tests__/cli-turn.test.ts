import { describe, expect, test } from "bun:test";
import {
	buildCliTurnPrompt,
	CLI_TURN_SCHEMA,
	parseCliTurn,
} from "../cli-turn";

const systemPrompt = "You are the edit assistant.";

describe("buildCliTurnPrompt", () => {
	test("embeds the system prompt, tool list, and conversation", () => {
		const prompt = buildCliTurnPrompt({
			systemPrompt,
			messages: [{ role: "user", content: "cut the silence" }],
			toolResults: [],
		});
		expect(prompt).toContain(systemPrompt);
		expect(prompt).toContain("- cut_range:");
		expect(prompt).toContain("USER: cut the silence");
		expect(prompt).toContain('"toolCalls"');
	});

	test("window is capped at 20 messages", () => {
		const messages = Array.from({ length: 30 }, (_, i) => ({
			role: "user" as const,
			content: `msg-${i}`,
		}));
		const prompt = buildCliTurnPrompt({ systemPrompt, messages, toolResults: [] });
		expect(prompt).not.toContain("msg-5\n");
		expect(prompt).toContain("msg-29");
	});

	test("tool results ride inline with OK/FAILED", () => {
		const prompt = buildCliTurnPrompt({
			systemPrompt,
			messages: [{ role: "user", content: "hi" }],
			toolResults: [
				{ toolCallId: "t1", ok: true, summary: "Cut 2s." },
				{ toolCallId: "t2", ok: false, summary: "" },
			],
		});
		expect(prompt).toContain("t1: OK — Cut 2s.");
		expect(prompt).toContain("t2: FAILED — Could not be applied.");
	});
});

describe("parseCliTurn", () => {
	test("normalizes tool calls with synthesized ids", () => {
		const res = parseCliTurn({
			raw: {
				text: "Cutting.",
				toolCalls: [
					{ name: "cut_range", args: { startSec: 1, endSec: 3 } },
					"garbage",
					{ args: {} },
				],
			},
		});
		expect(res.text).toBe("Cutting.");
		expect(res.toolCalls).toHaveLength(1);
		expect(res.toolCalls[0].name).toBe("cut_range");
		expect(res.toolCalls[0].args).toEqual({ startSec: 1, endSec: 3 });
		expect(res.stopReason).toBe("tool_use");
	});

	test("extracts ask_user question and options", () => {
		const res = parseCliTurn({
			raw: {
				text: "",
				toolCalls: [
					{
						name: "ask_user",
						args: { question: "Keep the intro?", options: ["Keep", "Cut it"] },
					},
				],
			},
		});
		expect(res.question).toBe("Keep the intro?");
		expect(res.questionOptions).toEqual(["Keep", "Cut it"]);
	});

	test("non-object raw degrades to an empty turn, not a throw", () => {
		const res = parseCliTurn({ raw: "the model ignored the schema" });
		expect(res.text).toBe("");
		expect(res.toolCalls).toEqual([]);
		expect(res.stopReason).toBe("end_turn");
	});

	test("schema enumerates every registered tool", () => {
		const items = (
			CLI_TURN_SCHEMA.properties.toolCalls as { items: { properties: { name: { enum: string[] } } } }
		).items.properties.name.enum;
		expect(items).toContain("cut_range");
		expect(items).toContain("ask_user");
	});
});
