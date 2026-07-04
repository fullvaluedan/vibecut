import { describe, expect, test } from "bun:test";
import { OFFLINE_VAD_OPTIONS, refineSpeechIntervals } from "../intervals";

const iv = (startSec: number, endSec: number) => ({ startSec, endSec });
const noPad = { padHeadSec: 0, padTailSec: 0 };

describe("refineSpeechIntervals", () => {
	test("merges near-adjacent speech (gap ≤ mergeGapSec)", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0, 2), iv(2.2, 4)],
			totalSec: 10,
			mergeGapSec: 0.3,
			...noPad,
		});
		expect(speech).toHaveLength(1);
		expect(speech[0]).toEqual({ startSec: 0, endSec: 4 });
	});

	test("keeps a real gap (> mergeGapSec) as two intervals", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0, 2), iv(5, 7)],
			totalSec: 10,
			mergeGapSec: 0.3,
			...noPad,
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
			...noPad,
		});
		expect(speech).toHaveLength(1);
		expect(speech[0]).toEqual({ startSec: 3, endSec: 5 });
	});

	test("pads speech edges ASYMMETRICALLY (less head, more tail) and clamps", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(1, 4)],
			totalSec: 5,
			padHeadSec: 0.2,
			padTailSec: 0.35,
		});
		expect(speech[0].startSec).toBeCloseTo(0.8, 5); // 1 - 0.2 head
		expect(speech[0].endSec).toBeCloseTo(4.35, 5); // 4 + 0.35 tail
	});

	test("edge padding is clamped to [0, totalSec]", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0.05, 4.9)],
			totalSec: 5,
			padHeadSec: 0.2,
			padTailSec: 0.35,
		});
		expect(speech[0].startSec).toBe(0); // 0.05 - 0.2 clamped to 0
		expect(speech[0].endSec).toBe(5); // 4.9 + 0.35 clamped to totalSec
	});

	test("padding-induced overlap re-merges into one interval", () => {
		const { speech } = refineSpeechIntervals({
			raw: [iv(0, 2), iv(2.5, 4)],
			totalSec: 10,
			mergeGapSec: 0.1, // 0.5 gap survives the merge
			padHeadSec: 0.3, // ...but padding closes it (0.35 tail + 0.3 head > 0.5)
			padTailSec: 0.35,
		});
		expect(speech).toHaveLength(1);
	});

	test("gaps are the exact complement covering [0, totalSec]", () => {
		const { speech, gaps } = refineSpeechIntervals({
			raw: [iv(2, 4), iv(6, 8)],
			totalSec: 10,
			...noPad,
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
		const { gaps } = refineSpeechIntervals({
			raw: [iv(0, 10)],
			totalSec: 10,
			...noPad,
		});
		expect(gaps).toEqual([]);
	});

	test("default dials are the auto-editor targets (U6): min removable silence, min island, asym pad", () => {
		// A 0.15s silence (< 0.2 min removable) is absorbed by the default merge.
		const merged = refineSpeechIntervals({
			raw: [iv(1, 2), iv(2.15, 3)],
			totalSec: 10,
			padHeadSec: 0,
			padTailSec: 0,
		});
		expect(merged.speech).toHaveLength(1);
		// A 0.15s island (> 0.1 min surviving island) survives at the default floor.
		const island = refineSpeechIntervals({
			raw: [iv(1, 1.15), iv(5, 6)],
			totalSec: 10,
			mergeGapSec: 0.05,
			padHeadSec: 0,
			padTailSec: 0,
		});
		expect(island.speech).toHaveLength(2);
		// Default padding is asymmetric: tail room exceeds head room.
		const padded = refineSpeechIntervals({ raw: [iv(3, 4)], totalSec: 10 });
		const headRoom = 3 - padded.speech[0].startSec;
		const tailRoom = padded.speech[0].endSec - 4;
		expect(tailRoom).toBeGreaterThan(headRoom);
	});
});

describe("OFFLINE_VAD_OPTIONS", () => {
	test("is tuned for offline cut detection, not mic streaming", () => {
		// minSpeechMs is raised above the library's 400ms mic default so blips
		// don't fragment silence; redemptionMs stays a positive grace period.
		expect(OFFLINE_VAD_OPTIONS.minSpeechMs).toBeGreaterThan(400);
		expect(OFFLINE_VAD_OPTIONS.redemptionMs).toBeGreaterThan(0);
	});
});
