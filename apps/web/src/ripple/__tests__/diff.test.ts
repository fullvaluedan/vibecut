import { describe, expect, it } from "bun:test";
import { computeRippleAdjustments } from "@/ripple/diff";
import type { SceneTracks } from "@/timeline/types";

/**
 * computeRippleAdjustments diffs before/after tracks and returns the gaps that
 * ripple should close. The diff only reads id/startTime/duration, so the test
 * builds minimal main-track scenes.
 */
type El = { id: string; startTime: number; duration: number };

function scene(mainEls: El[]): SceneTracks {
	// Minimal structural fixture; the diff only reads id/startTime/duration, and
	// real MediaTime branding needs @/wasm (unavailable under bun).
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {
		main: { id: "main", type: "video", elements: mainEls },
		overlay: [],
		audio: [],
	} as unknown as SceneTracks;
}

describe("computeRippleAdjustments — left-edge trims", () => {
	it("ripples the leading gap a left-trim opens (the fix)", () => {
		// B left-trimmed: start 100 -> 150, end stays 300 (duration 200 -> 150).
		const before = scene([
			{ id: "A", startTime: 0, duration: 100 },
			{ id: "B", startTime: 100, duration: 200 },
		]);
		const after = scene([
			{ id: "A", startTime: 0, duration: 100 },
			{ id: "B", startTime: 150, duration: 150 },
		]);
		expect(computeRippleAdjustments({ beforeTracks: before, afterTracks: after })).toEqual([
			{ trackId: "main", afterTime: 150, shiftAmount: 50 },
		]);
	});

	it("does NOT ripple a move-right (start AND end grow — not a trim)", () => {
		// B moved right by 50: start 100 -> 150, end 200 -> 250.
		const before = scene([{ id: "B", startTime: 100, duration: 100 }]);
		const after = scene([{ id: "B", startTime: 150, duration: 100 }]);
		expect(computeRippleAdjustments({ beforeTracks: before, afterTracks: after })).toEqual([]);
	});

	it("still ripples a right-trim (end shrinks) — unchanged behaviour", () => {
		// B right-trimmed: start stays 100, end 300 -> 250.
		const before = scene([{ id: "B", startTime: 100, duration: 200 }]);
		const after = scene([{ id: "B", startTime: 100, duration: 150 }]);
		expect(computeRippleAdjustments({ beforeTracks: before, afterTracks: after })).toEqual([
			{ trackId: "main", afterTime: 300, shiftAmount: 50 },
		]);
	});

	it("ripples both ends when a clip is trimmed on both sides", () => {
		// B: start 100 -> 150, end 300 -> 250.
		const before = scene([{ id: "B", startTime: 100, duration: 200 }]);
		const after = scene([{ id: "B", startTime: 150, duration: 100 }]);
		expect(
			computeRippleAdjustments({ beforeTracks: before, afterTracks: after }).sort(
				(a, b) => a.afterTime - b.afterTime,
			),
		).toEqual([
			{ trackId: "main", afterTime: 150, shiftAmount: 50 },
			{ trackId: "main", afterTime: 300, shiftAmount: 50 },
		]);
	});
});
