import { describe, expect, test } from "bun:test";
import { refineSpeechIntervals } from "../intervals";

const iv = (startSec: number, endSec: number) => ({ startSec, endSec });

describe("refineSpeechIntervals", () => {
	test("merges near-adjacent speech (gap ≤ mergeGapSec)", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0, 2), iv(2.2, 4)],
			totalSec: 10,
			mergeGapSec: 0.3,
			padSec: 0,
		});
		expect(speech).toHaveLength(1);
		expect(speech[0]).toEqual({ startSec: 0, endSec: 4 });
	});

	test("keeps a real gap (> mergeGapSec) as two intervals", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0, 2), iv(5, 7)],
			totalSec: 10,
			mergeGapSec: 0.3,
			padSec: 0,
		});
		expect(speech.map((s) => [s.startSec, s.endSec])).toEqual([
			[0, 2],
			[5, 7],
		]);
	});

	test("drops sub-min-duration blips", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0, 0.1), iv(3, 5)],
			totalSec: 10,
			minSpeechSec: 0.2,
			mergeGapSec: 0.05,
			padSec: 0,
		});
		expect(speech).toHaveLength(1);
		expect(speech[0]).toEqual({ startSec: 3, endSec: 5 });
	});

	test("pads speech edges and clamps to [0, totalSec]", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0.05, 4)],
			totalSec: 5,
			padSec: 0.15,
		});
		expect(speech[0].startSec).toBe(0); // 0.05 - 0.15 clamped to 0
		expect(speech[0].endSec).toBeCloseTo(4.15, 5);
	});

	test("padding-induced overlap re-merges into one interval", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0, 2), iv(2.5, 4)],
			totalSec: 10,
			mergeGapSec: 0.1, // 0.5 gap survives the merge
			padSec: 0.3, // ...but ±0.3 padding closes it → one interval
		});
		expect(speech).toHaveLength(1);
	});

	test("gaps are the exact complement covering [0, totalSec]", () => {
		const { speech, gaps } = refineSpeechIntervals({
			raw: [iv(2, 4), iv(6, 8)],
			totalSec: 10,
			padSec: 0,
		});
		expect(gaps.map((g) => [g.startSec, g.endSec])).toEqual([
			[0, 2],
			[4, 6],
			[8, 10],
		]);
		// speech ∪ gaps partitions [0,10] with no overlap
		const all = [...speech, ...gaps].sort((a, b) => a.startSec - b.startSec);
		let cursor = 0;
		for (const seg of all) {
			expect(seg.startSec).toBeCloseTo(cursor, 5);
			cursor = seg.endSec;
		}
		expect(cursor).toBe(10);
	});

	test("all-silence (no raw speech) → one gap covering the whole timeline", () => {
		const { speech, gaps } = refineSpeechIntervals({ raw: [], totalSec: 10 });
		expect(speech).toEqual([]);
		expect(gaps).toEqual([{ startSec: 0, endSec: 10 }]);
	});

	test("all-speech → no gaps", () => {
		const { gaps } = refineSpeechIntervals({ raw: [iv(0, 10)], totalSec: 10, padSec: 0 });
		expect(gaps).toEqual([]);
	});
});
