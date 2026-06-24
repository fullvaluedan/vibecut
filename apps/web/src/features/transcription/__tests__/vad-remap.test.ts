import { describe, expect, test } from "bun:test";
import { buildConcatSegments, concatSpeechSamples, remapBufferTimes } from "../vad-remap";

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

describe("concatSpeechSamples", () => {
	// sampleRate 10 → 1 sample = 0.1s; samples[i] = i so slices are verifiable.
	const samples = Float32Array.from({ length: 100 }, (_, i) => i);

	test("slices speech out of the samples + builds a sample-accurate concat map", () => {
		const { buffer, segments } = concatSpeechSamples({
			samples,
			sampleRate: 10,
			speech: [
				{ startSec: 0, endSec: 2 }, // samples 0..20
				{ startSec: 5, endSec: 7 }, // samples 50..70
			],
		});
		expect(buffer.length).toBe(40);
		expect(buffer[0]).toBe(0); // first sample of interval 1
		expect(buffer[20]).toBe(50); // first sample of interval 2 sits right after
		expect(segments).toEqual([
			{ bufferStartSec: 0, timelineStartSec: 0, durationSec: 2 },
			{ bufferStartSec: 2, timelineStartSec: 5, durationSec: 2 },
		]);
	});

	test("round-trips: a word in the concatenated buffer remaps to its real timeline spot", () => {
		const { segments } = concatSpeechSamples({
			samples,
			sampleRate: 10,
			speech: [{ startSec: 0, endSec: 2 }, { startSec: 5, endSec: 7 }],
		});
		// buffer 2.5s = 0.5s into the 2nd interval → timeline 5.5s
		const out = remapBufferTimes({ times: [{ start: 2.5, end: 2.9, text: "x" }], segments });
		expect(out[0].start).toBeCloseTo(5.5, 5);
		expect(out[0].end).toBeCloseTo(5.9, 5);
	});

	test("clamps out-of-range intervals + skips empties", () => {
		const { buffer, segments } = concatSpeechSamples({
			samples,
			sampleRate: 10,
			speech: [{ startSec: 8, endSec: 20 }, { startSec: 3, endSec: 3 }],
		});
		expect(buffer.length).toBe(20); // 8..10s clamped to samples 80..100; zero-length dropped
		expect(segments).toHaveLength(1);
	});

	test("no speech → empty buffer + no segments", () => {
		const { buffer, segments } = concatSpeechSamples({ samples, sampleRate: 10, speech: [] });
		expect(buffer.length).toBe(0);
		expect(segments).toEqual([]);
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
