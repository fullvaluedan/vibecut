import { describe, expect, test } from "bun:test";
import {
	buildRedundancyPrompt,
	renderRedundancyCatalog,
	sanitizeRedundancyPlan,
	type RedundancyLine,
} from "../llm-redundancy";

const line = ({
	lineId,
	startSec = 0,
	endSec = 1,
	text = "some words here",
	clipName,
	loudnessRelative,
	wpm,
	fillerCandidate,
}: {
	lineId: string;
	startSec?: number;
	endSec?: number;
	text?: string;
	clipName?: string;
	loudnessRelative?: number;
	wpm?: number;
	fillerCandidate?: boolean;
}): RedundancyLine => ({
	lineId,
	startSec,
	endSec,
	text,
	...(clipName !== undefined ? { clipName } : {}),
	...(loudnessRelative !== undefined ? { loudnessRelative } : {}),
	...(wpm !== undefined ? { wpm } : {}),
	...(fillerCandidate !== undefined ? { fillerCandidate } : {}),
});

const lines: RedundancyLine[] = [
	line({ lineId: "L0", startSec: 0, endSec: 2, text: "we ship on friday", loudnessRelative: 0.8, wpm: 140 }),
	line({ lineId: "L1", startSec: 3, endSec: 5, text: "the launch is friday", loudnessRelative: 0.6, wpm: 130 }),
	line({ lineId: "L2", startSec: 6, endSec: 8, text: "anyway here is the demo" }),
];

describe("buildRedundancyPrompt", () => {
	test("aims for recall while protecting intentional repetition", () => {
		const prompt = buildRedundancyPrompt({ lines });
		expect(prompt).toContain("RECALL");
		expect(prompt.toLowerCase()).toContain("callback");
		expect(prompt).toContain("SAME POINT");
		expect(prompt).toContain("[L0]");
	});

	test("renders a line with NO audio features without leaking undefined/NaN", () => {
		const out = renderRedundancyCatalog([line({ lineId: "L9", text: "no features here" })]);
		expect(out).not.toContain("undefined");
		expect(out).not.toContain("NaN");
		expect(out).toContain("[L9]");
	});
});

describe("sanitizeRedundancyPlan", () => {
	test("passes a well-formed 2-line group through with a valid keeper", () => {
		const plan = sanitizeRedundancyPlan(
			{ groups: [{ lineIds: ["L0", "L1"], keeperLineId: "L1", confidence: 0.9, reason: "same point" }] },
			lines,
		);
		expect(plan.groups).toHaveLength(1);
		expect(plan.groups[0].members.map((m) => m.lineId)).toEqual(["L0", "L1"]);
		expect(plan.groups[0].keeperLineId).toBe("L1");
	});

	test("drops a group referencing an unknown lineId (anti-hallucination)", () => {
		const plan = sanitizeRedundancyPlan(
			{ groups: [{ lineIds: ["L0", "GHOST"], keeperLineId: "L0", confidence: 0.9, reason: "x" }] },
			lines,
		);
		// GHOST dropped → only L0 survives → < 2 distinct → group dropped
		expect(plan.groups).toHaveLength(0);
	});

	test("dedupes a repeated lineId within a group before the member-count check", () => {
		expect(
			sanitizeRedundancyPlan(
				{ groups: [{ lineIds: ["L0", "L0"], keeperLineId: "L0", confidence: 0.9, reason: "x" }] },
				lines,
			).groups,
		).toHaveLength(0); // one distinct member → dropped
		const ok = sanitizeRedundancyPlan(
			{ groups: [{ lineIds: ["L0", "L0", "L1"], keeperLineId: "L0", confidence: 0.9, reason: "x" }] },
			lines,
		);
		expect(ok.groups).toHaveLength(1);
		expect(ok.groups[0].members.map((m) => m.lineId)).toEqual(["L0", "L1"]);
	});

	test("drops a group whose keeperLineId is not a surviving member", () => {
		const plan = sanitizeRedundancyPlan(
			{ groups: [{ lineIds: ["L0", "L1"], keeperLineId: "L2", confidence: 0.9, reason: "x" }] },
			lines,
		);
		expect(plan.groups).toHaveLength(0);
	});

	test("a line in two groups: the first claims it, the later group drops the shared id", () => {
		const plan = sanitizeRedundancyPlan(
			{
				groups: [
					{ lineIds: ["L0", "L1"], keeperLineId: "L1", confidence: 0.9, reason: "a" },
					{ lineIds: ["L1", "L2"], keeperLineId: "L2", confidence: 0.9, reason: "b" },
				],
			},
			lines,
		);
		// group 1 keeps L0,L1; group 2 loses L1 (claimed) → only L2 left → < 2 → dropped
		expect(plan.groups).toHaveLength(1);
		expect(plan.groups[0].members.map((m) => m.lineId)).toEqual(["L0", "L1"]);
	});

	test("never throws on malformed shapes", () => {
		expect(sanitizeRedundancyPlan(null, lines).groups).toEqual([]);
		expect(sanitizeRedundancyPlan({ groups: "x" }, lines).groups).toEqual([]);
		expect(
			sanitizeRedundancyPlan({ groups: [{ lineIds: "L0", keeperLineId: "L0", confidence: 1, reason: "x" }] }, lines)
				.groups,
		).toEqual([]); // lineIds not an array
		expect(
			sanitizeRedundancyPlan(
				{ groups: [{ lineIds: [0, 1], keeperLineId: "L0", confidence: 1, reason: "x" }] },
				lines,
			).groups,
		).toEqual([]); // numeric ids dropped → no members
	});

	test("clamps out-of-range confidence and defaults a non-numeric one", () => {
		const plan = sanitizeRedundancyPlan(
			{
				groups: [
					{ lineIds: ["L0", "L1"], keeperLineId: "L0", confidence: 5, reason: "x" },
					{ lineIds: ["L2"], keeperLineId: "L2", confidence: "high", reason: "y" },
				],
			},
			lines,
		);
		expect(plan.groups[0].confidence).toBe(1);
	});

	test("empty / no-groups input returns an empty plan", () => {
		expect(sanitizeRedundancyPlan({ groups: [] }, lines).groups).toEqual([]);
		expect(sanitizeRedundancyPlan({}, lines).groups).toEqual([]);
	});
});
