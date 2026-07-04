import { describe, expect, test } from "bun:test";
import { detectPacingCuts } from "../pacing";

const seg = ([start, end]: [number, number]) => ({ start, end });

describe("detectPacingCuts", () => {
	test("cuts the excess of a long gap, leaving the target beat", () => {
		// gap 1.2s (end 1.0 → start 2.2), min 0.8 / target 0.4 → cut [1.4, 2.2) = 0.8s
		const ops = detectPacingCuts({
			segments: [seg([0, 1.0]), seg([2.2, 3.0])],
			minGapSeconds: 0.8,
			targetGapSeconds: 0.4,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: "cut", category: "pacing" });
		expect(ops[0].startSec).toBeCloseTo(1.4);
		expect(ops[0].endSec).toBeCloseTo(2.2);
	});

	test("a gap under the minimum yields no cut", () => {
		const ops = detectPacingCuts({
			segments: [seg([0, 1.0]), seg([1.5, 2.0])],
			minGapSeconds: 0.8,
		});
		expect(ops).toEqual([]);
	});

	test("uses default min 0.8 / target 0.4 when not given", () => {
		// gap 0.9s → cut [1.4, 1.9) = 0.5s
		const ops = detectPacingCuts({ segments: [seg([0, 1.0]), seg([1.9, 2.5])] });
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(1.4);
		expect(ops[0].endSec).toBeCloseTo(1.9);
	});

	test("no/single segment yields nothing", () => {
		expect(detectPacingCuts({ segments: [] })).toEqual([]);
		expect(detectPacingCuts({ segments: [seg([0, 1])] })).toEqual([]);
	});
});
