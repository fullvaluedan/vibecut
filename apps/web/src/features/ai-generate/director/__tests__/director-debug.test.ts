import { describe, expect, test } from "bun:test";
import { buildOpeningDebugReport } from "../director-debug";
import type { DirectorOp } from "@framecut/hf-bridge";

const seg = ({ start, end, text }: { start: number; end: number; text: string }) => ({
	start,
	end,
	text,
});
const op = ({
	startSec,
	endSec,
	category,
}: {
	startSec: number;
	endSec: number;
	category?: DirectorOp["category"];
}): DirectorOp => ({
	id: `t-${startSec}`,
	op: "cut",
	startSec,
	endSec,
	reason: "test",
	confidence: 0.5,
	...(category ? { category } : {}),
});

describe("buildOpeningDebugReport", () => {
	test("lists opening segments, similarity, and ops within the window", () => {
		const segments = [
			seg({ start: 0, end: 2, text: "welcome to the channel today we talk about money" }),
			seg({ start: 2.5, end: 4.5, text: "today we are going to talk about money on this channel" }),
			seg({ start: 40, end: 42, text: "this is way past the opening window" }),
		];
		const planOps = [op({ startSec: 2.5, endSec: 4.5 })];
		const operations: DirectorOp[] = [];
		const report = buildOpeningDebugReport({ segments, planOps, operations, openingSec: 30 });

		// Only the two opening segments are inspected (the 40s one is excluded).
		expect(report).toContain("opening 2 segment(s)");
		expect(report).toContain("#0~#1:");
		expect(report).not.toContain("past the opening window");
		// The LLM proposed a cut in the opening; the final list is empty here.
		expect(report).toContain("RAW LLM ops in opening: cut");
		expect(report).toContain("FINAL merged ops in opening: (none)");
	});

	test("flags a near-verbatim opening pair as clearing the merge bar", () => {
		const segments = [
			seg({ start: 0, end: 2, text: "the quick brown fox jumps over the lazy dog" }),
			seg({ start: 3, end: 5, text: "the quick brown fox jumps over the lazy dog" }),
		];
		const report = buildOpeningDebugReport({ segments, planOps: [], operations: [] });
		expect(report).toContain("clears bar (would cluster)");
		expect(report).toContain("(none — the LLM proposed no cut here)");
	});

	test("notes when there is only one opening segment to compare", () => {
		const segments = [seg({ start: 0, end: 2, text: "just one line at the start" })];
		const report = buildOpeningDebugReport({ segments, planOps: [], operations: [] });
		expect(report).toContain("need ≥2 opening segments to compare");
	});
});
