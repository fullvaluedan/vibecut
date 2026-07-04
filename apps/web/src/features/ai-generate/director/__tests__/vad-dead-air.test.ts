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

	test("an interior gap at or below the threshold → no op", () => {
		expect(detectVadDeadAirCuts({ gaps: [gap({ startSec: 10, endSec: 11.5 })], minGapSeconds: 1.5 })).toHaveLength(0);
		expect(detectVadDeadAirCuts({ gaps: [gap({ startSec: 10, endSec: 11.2 })], minGapSeconds: 1.5 })).toHaveLength(0);
	});

	test("padding that would collapse an interior cut → no op", () => {
		// over the (low) min-gap, but 2×pad ≥ duration leaves nothing to cut
		const ops = detectVadDeadAirCuts({ gaps: [gap({ startSec: 10, endSec: 10.5 })], minGapSeconds: 0.1, padSeconds: 0.3 });
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
		const ops = detectVadDeadAirCuts({ gaps: [gap({ startSec: 10, endSec: 14 })], minGapSeconds: 1.5, padSeconds: 0.3 });
		expect(ops[0].reason).toContain("4.0s");
	});
});

// Silence rework (2026-07-04): leading/trailing silence cuts FLUSH at the timeline
// edge with a lower floor - padding there protected nothing and left the silent
// stub that became the tiny head clip on Dan's timeline.
describe("detectVadDeadAirCuts edge handling", () => {
	test("leading silence cuts FLUSH at 0 (no head stub)", () => {
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 0, endSec: 3 })],
			minGapSeconds: 1.5,
			padSeconds: 0.3,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBe(0); // flush, not 0.3
		expect(ops[0].endSec).toBeCloseTo(2.7, 5); // speech side keeps its pad
		expect(ops[0].reason).toContain("Leading silence");
	});

	test("a short leading gap above the edge floor still cuts (0.8s head silence)", () => {
		// 0.8s is below the 1.5s interior floor but above the 0.5s edge floor.
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 0, endSec: 0.8 })],
			minGapSeconds: 1.5,
			padSeconds: 0.3,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBe(0);
		expect(ops[0].endSec).toBeCloseTo(0.5, 5);
	});

	test("a leading gap below the edge floor → no op", () => {
		expect(
			detectVadDeadAirCuts({ gaps: [gap({ startSec: 0, endSec: 0.4 })], minGapSeconds: 1.5 }),
		).toHaveLength(0);
	});

	test("trailing silence cuts FLUSH at the timeline end", () => {
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 57, endSec: 60 })],
			minGapSeconds: 1.5,
			padSeconds: 0.3,
			totalSec: 60,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(57.3, 5); // speech side keeps its pad
		expect(ops[0].endSec).toBe(60); // flush at the end
		expect(ops[0].reason).toContain("Trailing silence");
	});

	test("without totalSec a gap at the end is treated as interior (no flush guess)", () => {
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 57, endSec: 60 })],
			minGapSeconds: 1.5,
			padSeconds: 0.3,
		});
		expect(ops[0].endSec).toBeCloseTo(59.7, 5);
	});
});

// Review X5: VAD gaps are NON-speech, not silence. Energetic edge gaps (music,
// b-roll) and whole-timeline cuts must never auto-accept.
describe("detectVadDeadAirCuts intent guards (review X5)", () => {
	test("an ENERGETIC leading gap (music intro) is opt-in with an honest reason", () => {
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 0, endSec: 3 })],
			totalSec: 60,
			isEnergetic: () => true,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(false);
		expect(ops[0].reason).toContain("music or b-roll");
	});

	test("a genuinely silent leading gap still auto-accepts", () => {
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 0, endSec: 3 })],
			totalSec: 60,
			isEnergetic: () => false,
		});
		expect(ops[0].defaultAccept).toBeUndefined(); // absent = accepted
		expect(ops[0].reason).toContain("Leading silence");
	});

	test("an energetic INTERIOR gap keeps the default (scope: edges only)", () => {
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 20, endSec: 24 })],
			totalSec: 60,
			isEnergetic: () => true,
		});
		expect(ops[0].defaultAccept).toBeUndefined();
	});

	test("a cut spanning most of the timeline is never auto-accepted (wipe guard)", () => {
		// VAD found no speech: one gap covering everything -> one flush cut.
		const ops = detectVadDeadAirCuts({
			gaps: [gap({ startSec: 0, endSec: 60 })],
			totalSec: 60,
			isEnergetic: () => false,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBe(0);
		expect(ops[0].endSec).toBe(60);
		expect(ops[0].defaultAccept).toBe(false); // one row cannot wipe the timeline
	});
});
