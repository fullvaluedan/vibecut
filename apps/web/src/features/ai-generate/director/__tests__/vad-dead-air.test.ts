import { describe, expect, test } from "bun:test";
import { detectVadDeadAirCuts } from "../vad-dead-air";

const gap = ({ startSec, endSec }: { startSec: number; endSec: number }) => ({ startSec, endSec });

describe("detectVadDeadAirCuts", () => {
	test("a gap longer than the threshold → one padded deadair cut", () => {
		const ops = detectVadDeadAirCuts({ gaps: [gap({ startSec: 10, endSec: 14 })], minGapSeconds: 1.5, padSeconds: 0.3 });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("deadair");
		// padded by 0.3 at each edge
		expect(ops[0].startSec).toBeCloseTo(10.3, 5);
		expect(ops[0].endSec).toBeCloseTo(13.7, 5);
	});

	test("a gap at or below the threshold → no op", () => {
		expect(detectVadDeadAirCuts({ gaps: [gap({ startSec: 0, endSec: 1.5 })], minGapSeconds: 1.5 })).toHaveLength(0);
		expect(detectVadDeadAirCuts({ gaps: [gap({ startSec: 0, endSec: 1.2 })], minGapSeconds: 1.5 })).toHaveLength(0);
	});

	test("padding that would collapse the cut → no op", () => {
		// over the (low) min-gap, but 2×pad ≥ duration leaves nothing to cut
		const ops = detectVadDeadAirCuts({ gaps: [gap({ startSec: 0, endSec: 0.5 })], minGapSeconds: 0.1, padSeconds: 0.3 });
		expect(ops).toHaveLength(0);
	});

	test("back-to-back gaps → one cut each (distinct ids)", () => {
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 5, endSec: 8 }), gap({ startSec: 20, endSec: 23 })],
			minGapSeconds: 1.5,
		});
		expect(ops).toHaveLength(2);
		expect(new Set(ops.map((o) => o.id)).size).toBe(2);
		expect(ops.map((o) => Math.round(o.startSec))).toEqual([5, 20]);
	});

	test("no gaps → no ops", () => {
		expect(detectVadDeadAirCuts({ gaps: [] })).toEqual([]);
	});

	test("reason reports the FULL gap duration, not the padded cut", () => {
		const ops = detectVadDeadAirCuts({ gaps: [gap({ startSec: 0, endSec: 4 })], minGapSeconds: 1.5, padSeconds: 0.3 });
		expect(ops[0].reason).toContain("4.0s");
	});
});
