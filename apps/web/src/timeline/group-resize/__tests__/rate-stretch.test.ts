import { describe, expect, test } from "bun:test";
import { computeRateStretchTarget } from "../rate-stretch";

// A 1-second clip at 120_000 ticks/second, source window == on-timeline length
// (rate 1, no trim). minDuration is a single frame at 30fps == 4_000 ticks.
const base = {
	side: "right" as const,
	startTimeTicks: 0,
	durationTicks: 120_000,
	trimStartTicks: 0,
	trimEndTicks: 0,
	sourceDurationTicks: 120_000,
	deltaTicks: 0,
	leftNeighborBoundTicks: null,
	rightNeighborBoundTicks: null,
	minDurationTicks: 4_000,
};

describe("computeRateStretchTarget", () => {
	test("right edge pulled out doubles the length and halves the rate", () => {
		const result = computeRateStretchTarget({ ...base, deltaTicks: 120_000 });
		expect(result).toEqual({
			rate: 0.5,
			newDurationTicks: 240_000,
			newStartTimeTicks: 0,
		});
	});

	test("right edge pushed in shortens the clip and speeds it up", () => {
		const result = computeRateStretchTarget({ ...base, deltaTicks: -60_000 });
		expect(result).toEqual({
			rate: 2,
			newDurationTicks: 60_000,
			newStartTimeTicks: 0,
		});
	});

	test("right edge is clamped to the next clip and the rate follows", () => {
		const result = computeRateStretchTarget({
			...base,
			deltaTicks: 120_000,
			rightNeighborBoundTicks: 180_000,
		});
		expect(result?.newDurationTicks).toBe(180_000);
		expect(result?.newStartTimeTicks).toBe(0);
		expect(result?.rate ?? 0).toBeCloseTo(2 / 3, 6);
	});

	test("the rate saturates at the 0.01x floor instead of going lower", () => {
		const result = computeRateStretchTarget({ ...base, deltaTicks: 120_000_000 });
		expect(result?.rate).toBe(0.01);
		expect(result?.newDurationTicks).toBe(12_000_000);
	});

	test("left edge pulled out keeps the end pinned and moves the start", () => {
		const result = computeRateStretchTarget({
			...base,
			side: "left",
			startTimeTicks: 120_000,
			durationTicks: 120_000,
			deltaTicks: -120_000,
		});
		expect(result).toEqual({
			rate: 0.5,
			newDurationTicks: 240_000,
			newStartTimeTicks: 0,
		});
	});

	test("left edge is clamped to the previous clip's end", () => {
		const result = computeRateStretchTarget({
			...base,
			side: "left",
			startTimeTicks: 120_000,
			durationTicks: 120_000,
			deltaTicks: -120_000,
			leftNeighborBoundTicks: 60_000,
		});
		expect(result?.newDurationTicks).toBe(180_000);
		expect(result?.newStartTimeTicks).toBe(60_000);
	});

	test("an element with no usable source window is not stretchable", () => {
		const result = computeRateStretchTarget({
			...base,
			trimStartTicks: 60_000,
			trimEndTicks: 60_000,
			deltaTicks: 60_000,
		});
		expect(result).toBeNull();
	});
});
