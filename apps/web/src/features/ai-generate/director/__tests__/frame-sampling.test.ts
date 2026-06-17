import { describe, expect, test } from "bun:test";
import {
	cadenceSampleTimes,
	clampSampleTimes,
	frameSize,
	histogramDelta,
	lumaHistogram,
	pickSceneStartTimes,
	throwIfAborted,
} from "../frame-sampling";

describe("frameSize", () => {
	test("downscales the long edge to the cap, preserving aspect", () => {
		expect(frameSize({ width: 1920, height: 1080, maxLongEdge: 768 })).toEqual({
			width: 768,
			height: 432,
		});
		// Portrait: the long edge is the height.
		expect(frameSize({ width: 1080, height: 1920, maxLongEdge: 768 })).toEqual({
			width: 432,
			height: 768,
		});
	});

	test("never upscales a small frame and handles degenerate input", () => {
		expect(frameSize({ width: 320, height: 240, maxLongEdge: 768 })).toEqual({
			width: 320,
			height: 240,
		});
		expect(frameSize({ width: 0, height: 100 })).toEqual({ width: 0, height: 0 });
	});
});

describe("clampSampleTimes", () => {
	test("clamps times past the end to the duration (last frame), not throwing", () => {
		expect(
			clampSampleTimes({ timesSec: [-1, 0, 5, 12, 99], durationSec: 10 }),
		).toEqual([0, 0, 5, 10, 10]);
	});

	test("non-finite times collapse to 0", () => {
		expect(clampSampleTimes({ timesSec: [NaN, Infinity], durationSec: 10 })).toEqual([
			0, 10,
		]);
	});
});

describe("cadenceSampleTimes", () => {
	test("produces 0, interval, 2·interval … strictly inside the duration", () => {
		expect(cadenceSampleTimes({ durationSec: 7, intervalSec: 2 })).toEqual([0, 2, 4, 6]);
	});

	test("always yields at least [0] for short/still clips", () => {
		expect(cadenceSampleTimes({ durationSec: 1, intervalSec: 2 })).toEqual([0]);
		expect(cadenceSampleTimes({ durationSec: 0, intervalSec: 2 })).toEqual([0]);
	});
});

describe("lumaHistogram + histogramDelta", () => {
	test("buckets black and white pixels at the extremes and normalizes", () => {
		// One black pixel, one white pixel (RGBA).
		const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
		const hist = lumaHistogram({ rgba, bins: 16 });
		expect(hist[0]).toBeCloseTo(0.5, 5);
		expect(hist[15]).toBeCloseTo(0.5, 5);
		expect(hist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
	});

	test("empty pixels yield an all-zero histogram (no divide-by-zero)", () => {
		expect(lumaHistogram({ rgba: new Uint8ClampedArray([]), bins: 4 })).toEqual([
			0, 0, 0, 0,
		]);
	});

	test("delta is 0 for identical histograms and 1 for disjoint ones", () => {
		const black = [1, 0, 0, 0];
		const white = [0, 0, 0, 1];
		expect(histogramDelta({ a: black, b: black })).toBe(0);
		expect(histogramDelta({ a: black, b: white })).toBe(1);
	});
});

describe("pickSceneStartTimes", () => {
	const black = [1, 0];
	const white = [0, 1];

	test("a hard cut yields a scene start near the cut; frame 0 always starts one", () => {
		// dark, dark, BRIGHT, bright — the cut is at index 2 (time 4).
		const starts = pickSceneStartTimes({
			histograms: [black, black, white, white],
			times: [0, 2, 4, 6],
			threshold: 0.35,
		});
		expect(starts).toEqual([0, 4]);
	});

	test("a static clip yields only the first frame", () => {
		const starts = pickSceneStartTimes({
			histograms: [black, black, black, black],
			times: [0, 2, 4, 6],
		});
		expect(starts).toEqual([0]);
	});

	test("throws on a histograms/times length mismatch", () => {
		expect(() =>
			pickSceneStartTimes({ histograms: [black], times: [0, 2] }),
		).toThrow(/length mismatch/);
	});

	test("empty histograms/times yields an empty list", () => {
		expect(pickSceneStartTimes({ histograms: [], times: [] })).toEqual([]);
	});
});

describe("throwIfAborted", () => {
	test("throws Cancelled when the signal is aborted, otherwise is a no-op", () => {
		const controller = new AbortController();
		expect(() => throwIfAborted(controller.signal)).not.toThrow();
		expect(() => throwIfAborted(undefined)).not.toThrow();
		controller.abort();
		expect(() => throwIfAborted(controller.signal)).toThrow(/Cancelled/);
	});
});
