import { describe, expect, test } from "bun:test";
import { leadingWindow, WORD_PROBE_WINDOW_SECONDS } from "../probe";

describe("leadingWindow", () => {
	test("returns a leading slice of the requested length", () => {
		const samples = new Float32Array([1, 2, 3, 4, 5, 6]);
		const window = leadingWindow({ samples, windowSamples: 3 });
		expect(Array.from(window)).toEqual([1, 2, 3]);
	});

	test("returns the whole array when it is shorter than the window", () => {
		const samples = new Float32Array([1, 2]);
		const window = leadingWindow({ samples, windowSamples: 10 });
		expect(window).toBe(samples); // same reference, no copy
		expect(Array.from(window)).toEqual([1, 2]);
	});

	test("returns the whole array when equal to the window", () => {
		const samples = new Float32Array([1, 2, 3]);
		expect(leadingWindow({ samples, windowSamples: 3 })).toBe(samples);
	});

	test("is a view (no copy) when slicing", () => {
		const samples = new Float32Array([1, 2, 3, 4]);
		const window = leadingWindow({ samples, windowSamples: 2 });
		expect(window.buffer).toBe(samples.buffer); // shares the backing buffer
	});

	test("empty / non-positive window yields an empty slice", () => {
		const samples = new Float32Array([1, 2, 3]);
		expect(leadingWindow({ samples, windowSamples: 0 }).length).toBe(0);
		expect(leadingWindow({ samples, windowSamples: -5 }).length).toBe(0);
	});

	test("probe window is a sane, sub-chunk duration", () => {
		// Must be > 0 and below Whisper's 30s chunk so the probe stays one chunk.
		expect(WORD_PROBE_WINDOW_SECONDS).toBeGreaterThan(0);
		expect(WORD_PROBE_WINDOW_SECONDS).toBeLessThan(30);
	});
});
