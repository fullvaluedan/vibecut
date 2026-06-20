import { describe, expect, test } from "bun:test";
import { detectSegmentRepeatCuts } from "../segment-repeat";

function seg({
	start,
	end,
	text,
}: {
	start: number;
	end: number;
	text: string;
}) {
	return { start, end, text };
}

describe("detectSegmentRepeatCuts", () => {
	test("cuts all but the LAST of three back-to-back identical takes", () => {
		const ops = detectSegmentRepeatCuts({
			segments: [
				seg({ start: 0, end: 2, text: "I really hate OneDrive so much" }),
				seg({ start: 2.1, end: 4, text: "I really hate OneDrive so much" }),
				seg({ start: 4.1, end: 6, text: "I really hate OneDrive so much" }),
				seg({ start: 6.1, end: 8, text: "anyway here is the actual point" }),
			],
		});
		expect(ops).toHaveLength(2);
		// The first two are cut; the third (kept) is NOT in the ops.
		expect(ops.map((o) => o.startSec)).toEqual([0, 2.1]);
		expect(ops.every((o) => o.op === "cut" && o.category === "repeat")).toBe(true);
		expect(ops[0].reason).toContain("3 back-to-back takes");
	});

	test("near-verbatim restatement (a couple of extra words) still matches", () => {
		const ops = detectSegmentRepeatCuts({
			segments: [
				seg({ start: 0, end: 2, text: "let me show you how this works" }),
				seg({ start: 2.1, end: 4.2, text: "let me show you how this works okay" }),
				seg({ start: 4.3, end: 7, text: "first you open the settings panel" }),
			],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBe(0);
	});

	test("distinct consecutive lines are left alone", () => {
		const ops = detectSegmentRepeatCuts({
			segments: [
				seg({ start: 0, end: 2, text: "today we are building a video editor" }),
				seg({ start: 2.1, end: 4, text: "it runs entirely in the browser" }),
				seg({ start: 4.1, end: 6, text: "no uploads no servers nothing" }),
			],
		});
		expect(ops).toHaveLength(0);
	});

	test("short interjections are not anchored (avoids cutting 'yeah yeah')", () => {
		const ops = detectSegmentRepeatCuts({
			segments: [
				seg({ start: 0, end: 0.5, text: "yeah" }),
				seg({ start: 0.6, end: 1, text: "yeah" }),
				seg({ start: 1.1, end: 1.5, text: "yeah" }),
			],
		});
		expect(ops).toHaveLength(0);
	});

	test("a far-apart repeat (beyond the window) reads as a callback, not a restart", () => {
		const ops = detectSegmentRepeatCuts({
			segments: [
				seg({ start: 0, end: 2, text: "remember to like and subscribe please" }),
				seg({ start: 120, end: 122, text: "remember to like and subscribe please" }),
			],
		});
		expect(ops).toHaveLength(0);
	});

	test("two separate repeat runs each keep their own last take", () => {
		const ops = detectSegmentRepeatCuts({
			segments: [
				seg({ start: 0, end: 2, text: "the first thing you need to know" }),
				seg({ start: 2.1, end: 4, text: "the first thing you need to know" }),
				seg({ start: 4.1, end: 7, text: "moving on to the second part now" }),
				seg({ start: 7.1, end: 9, text: "and the third point is really important" }),
				seg({ start: 9.1, end: 11, text: "and the third point is really important" }),
			],
		});
		expect(ops.map((o) => o.startSec)).toEqual([0, 7.1]);
	});

	test("empty / single-segment input yields nothing", () => {
		expect(detectSegmentRepeatCuts({ segments: [] })).toHaveLength(0);
		expect(
			detectSegmentRepeatCuts({
				segments: [seg({ start: 0, end: 2, text: "only one line here friend" })],
			}),
		).toHaveLength(0);
	});
});
