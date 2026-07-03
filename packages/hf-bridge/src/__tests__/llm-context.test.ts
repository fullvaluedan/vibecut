import { describe, expect, test } from "bun:test";
import {
	buildContextPrompt,
	renderContextCatalog,
	sanitizeContextPlan,
} from "../llm-context";
import type { RedundancyLine } from "../llm-redundancy";

const line = ({
	lineId,
	startSec = 0,
	endSec = 1,
	text = "some words here",
	clipName,
}: {
	lineId: string;
	startSec?: number;
	endSec?: number;
	text?: string;
	clipName?: string;
}): RedundancyLine => ({
	lineId,
	startSec,
	endSec,
	text,
	...(clipName !== undefined ? { clipName } : {}),
});

const lines: RedundancyLine[] = [
	line({ lineId: "L0", startSec: 0, endSec: 2, text: "today I'll show you how to build a website" }),
	line({ lineId: "L1", startSec: 3, endSec: 5, text: "oh wait, let me redo that intro" }),
	line({ lineId: "L2", startSec: 6, endSec: 8, text: "first, pick a domain name" }),
];

describe("buildContextPrompt / renderContextCatalog", () => {
	test("emphasizes PRECISION over recall and includes every line in order", () => {
		const prompt = buildContextPrompt({ lines });
		expect(prompt).toContain("PRECISION");
		expect(prompt.toLowerCase()).toContain("throughline");
		expect(prompt).toContain("[L0]");
		expect(prompt).toContain("[L1]");
		expect(prompt).toContain("[L2]");
		// L0 must render before L2 (full transcript, in order).
		expect(prompt.indexOf("[L0]")).toBeLessThan(prompt.indexOf("[L2]"));
	});

	test("renders a line without leaking undefined/NaN", () => {
		const out = renderContextCatalog([line({ lineId: "L9", text: "no clip here" })]);
		expect(out).not.toContain("undefined");
		expect(out).not.toContain("NaN");
		expect(out).toContain("[L9]");
	});

	test("includes editor taste when provided", () => {
		expect(buildContextPrompt({ lines, taste: "be conservative" })).toContain("be conservative");
	});
});

describe("sanitizeContextPlan", () => {
	test("keeps the topic and resolves a flag to its real line span", () => {
		const plan = sanitizeContextPlan(
			{ topic: "how to build a website", flags: [{ lineId: "L1", confidence: 0.8, reason: "meta aside" }] },
			lines,
		);
		expect(plan.topic).toBe("how to build a website");
		expect(plan.flags).toHaveLength(1);
		expect(plan.flags[0]).toMatchObject({ lineId: "L1", startSec: 3, endSec: 5, confidence: 0.8, reason: "meta aside" });
	});

	test("drops an unknown lineId (anti-hallucination)", () => {
		const plan = sanitizeContextPlan(
			{ topic: "t", flags: [{ lineId: "GHOST", confidence: 0.9, reason: "x" }] },
			lines,
		);
		expect(plan.flags).toHaveLength(0);
	});

	test("dedupes a lineId flagged twice", () => {
		const plan = sanitizeContextPlan(
			{
				topic: "t",
				flags: [
					{ lineId: "L1", confidence: 0.9, reason: "a" },
					{ lineId: "L1", confidence: 0.5, reason: "b" },
				],
			},
			lines,
		);
		expect(plan.flags).toHaveLength(1);
		expect(plan.flags[0].reason).toBe("a"); // first wins
	});

	test("clamps out-of-range confidence and defaults a non-numeric one", () => {
		const plan = sanitizeContextPlan(
			{
				topic: "t",
				flags: [
					{ lineId: "L0", confidence: 5, reason: "x" },
					{ lineId: "L1", confidence: "high", reason: "y" },
				],
			},
			lines,
		);
		expect(plan.flags[0].confidence).toBe(1);
		expect(plan.flags[1].confidence).toBe(0.5);
	});

	test("never throws on malformed shapes and returns an empty plan", () => {
		expect(sanitizeContextPlan(null, lines).flags).toEqual([]);
		expect(sanitizeContextPlan(null, lines).topic).toBe("");
		expect(sanitizeContextPlan({ flags: "x" }, lines).flags).toEqual([]);
		expect(sanitizeContextPlan({ topic: "t", flags: [{ confidence: 1, reason: "x" }] }, lines).flags).toEqual([]);
		expect(sanitizeContextPlan({ topic: "t", flags: [{ lineId: 0, confidence: 1, reason: "x" }] }, lines).flags).toEqual([]);
	});

	test("empty flags input returns an empty flags array", () => {
		expect(sanitizeContextPlan({ topic: "t", flags: [] }, lines).flags).toEqual([]);
	});
});
