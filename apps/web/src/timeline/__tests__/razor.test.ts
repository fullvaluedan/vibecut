import { describe, expect, test } from "bun:test";
import { razorSplitTimeTicks } from "../razor";

// BASE_TIMELINE_PIXELS_PER_SECOND = 50 (timeline/scale.ts). With the canonical
// 120_000 ticks/second, at zoomLevel 1 one CSS px == 120_000 / 50 == 2_400 ticks.
const TICKS_PER_SECOND = 120_000;

describe("razorSplitTimeTicks", () => {
	test("maps the click X within a clip to an absolute timeline time", () => {
		// Clip starts at 10_000 ticks; click 50px in at zoom 1 => +1s == 120_000.
		expect(
			razorSplitTimeTicks({
				offsetXPx: 50,
				elementStartTimeTicks: 10_000,
				elementDurationTicks: 1_000_000,
				zoomLevel: 1,
				ticksPerSecond: TICKS_PER_SECOND,
			}),
		).toBe(10_000 + 120_000);
	});

	test("zoom scales the pixels-per-tick conversion", () => {
		// At zoom 2, 50px == half a second == 60_000 ticks.
		expect(
			razorSplitTimeTicks({
				offsetXPx: 50,
				elementStartTimeTicks: 0,
				elementDurationTicks: 1_000_000,
				zoomLevel: 2,
				ticksPerSecond: TICKS_PER_SECOND,
			}),
		).toBe(60_000);
	});

	test("clamps to just inside the clip start (no left-edge no-op)", () => {
		expect(
			razorSplitTimeTicks({
				offsetXPx: 0,
				elementStartTimeTicks: 5_000,
				elementDurationTicks: 100_000,
				zoomLevel: 1,
				ticksPerSecond: TICKS_PER_SECOND,
			}),
		).toBe(5_001);
	});

	test("clamps to just inside the clip end (no right-edge no-op)", () => {
		// A click far past the right edge clamps to start + duration - 1.
		expect(
			razorSplitTimeTicks({
				offsetXPx: 100_000,
				elementStartTimeTicks: 5_000,
				elementDurationTicks: 100_000,
				zoomLevel: 1,
				ticksPerSecond: TICKS_PER_SECOND,
			}),
		).toBe(5_000 + 100_000 - 1);
	});

	test("negative offset (click left of the clip) clamps to start+1", () => {
		expect(
			razorSplitTimeTicks({
				offsetXPx: -25,
				elementStartTimeTicks: 5_000,
				elementDurationTicks: 100_000,
				zoomLevel: 1,
				ticksPerSecond: TICKS_PER_SECOND,
			}),
		).toBe(5_001);
	});

	test("degenerate 1-tick clip falls back to the clip midpoint", () => {
		expect(
			razorSplitTimeTicks({
				offsetXPx: 10,
				elementStartTimeTicks: 5_000,
				elementDurationTicks: 1,
				zoomLevel: 1,
				ticksPerSecond: TICKS_PER_SECOND,
			}),
		).toBe(5_000);
	});
});
