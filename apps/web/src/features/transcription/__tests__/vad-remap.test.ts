import { describe, expect, test } from "bun:test";
import { buildConcatSegments, remapBufferTimes } from "../vad-remap";

const t = (start: number, end: number, text: string) => ({ start, end, text });

describe("buildConcatSegments", () => {
	test("lays speech intervals back-to-back; bufferStart = running duration sum", () => {
		const segs = buildConcatSegments([
			{ startSec: 10, endSec: 13 }, // 3s
			{ startSec: 20, endSec: 24 }, // 4s
		]);
		expect(segs).toEqual([
			{ bufferStartSec: 0, timelineStartSec: 10, durationSec: 3 },
			{ bufferStartSec: 3, timelineStartSec: 20, durationSec: 4 },
		]);
	});

	test("skips zero/negative-length intervals", () => {
		expect(buildConcatSegments([{ startSec: 5, endSec: 5 }])).toEqual([]);
	});
});

describe("remapBufferTimes", () => {
	const segs = buildConcatSegments([
		{ startSec: 10, endSec: 13 }, // buffer 0..3   → timeline 10..13
		{ startSec: 20, endSec: 24 }, // buffer 3..7   → timeline 20..24
	]);

	test("single-interval offset", () => {
		const out = remapBufferTimes({ times: [t(0.5, 1.5, "hi")], segments: segs });
		expect(out).toEqual([t(10.5, 11.5, "hi")]);
	});

	test("a word in the SECOND interval maps to the right absolute place", () => {
		// buffer 4.0 is 1.0s into the second interval → timeline 21.0
		const out = remapBufferTimes({ times: [t(4, 4.4, "world")], segments: segs });
		expect(out[0].start).toBeCloseTo(21, 5);
		expect(out[0].end).toBeCloseTo(21.4, 5);
	});

	test("times across both intervals stay monotonic + land in the right absolute positions", () => {
		// "c" starts exactly on the seam (buffer 3.0) → belongs to the 2nd interval (timeline 20)
		const out = remapBufferTimes({
			times: [t(0, 1, "a"), t(2, 2.8, "b"), t(3, 4, "c"), t(6, 6.9, "d")],
			segments: segs,
		});
		expect(out.map((o) => Math.round(o.start))).toEqual([10, 12, 20, 23]);
		for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start);
	});

	test("a word overrunning a concat seam is clamped to its segment's timeline end", () => {
		// starts at buffer 2.9 (in seg 1, ends at timeline 13); raw end 3.5 would bleed past
		const out = remapBufferTimes({ times: [t(2.9, 3.5, "seam")], segments: segs });
		expect(out[0].start).toBeCloseTo(12.9, 5);
		expect(out[0].end).toBeCloseTo(13, 5); // clamped, not 13.5
	});

	test("empty times → empty", () => {
		expect(remapBufferTimes({ times: [], segments: segs })).toEqual([]);
	});

	test("a time outside every segment is dropped defensively", () => {
		expect(remapBufferTimes({ times: [t(100, 101, "x")], segments: segs })).toEqual([]);
	});
});
