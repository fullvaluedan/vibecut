import { describe, expect, test } from "bun:test";
import { rateForTargetDuration, targetDurationForRate } from "../duration";

describe("retime duration <-> rate", () => {
	// A 10s source window (in arbitrary plain units — ticks or seconds).
	const sourceWindowTicks = 10_000;

	test("target duration shorter than source -> faster rate", () => {
		// Want the clip to occupy 5_000 -> must play at 2x.
		expect(
			rateForTargetDuration({ sourceWindowTicks, targetTicks: 5_000 }),
		).toBe(2);
	});

	test("target duration longer than source -> slower rate", () => {
		// Want the clip to occupy 20_000 -> must play at 0.5x.
		expect(
			rateForTargetDuration({ sourceWindowTicks, targetTicks: 20_000 }),
		).toBe(0.5);
	});

	test("target duration equal to source -> 1x", () => {
		expect(
			rateForTargetDuration({ sourceWindowTicks, targetTicks: 10_000 }),
		).toBe(1);
	});

	test("rate -> expected duration (2x halves the source window)", () => {
		expect(targetDurationForRate({ sourceWindowTicks, rate: 2 })).toBe(5_000);
	});

	test("rate -> expected duration (0.5x doubles the source window)", () => {
		expect(targetDurationForRate({ sourceWindowTicks, rate: 0.5 })).toBe(20_000);
	});

	test("rate -> expected duration (1x is identity)", () => {
		expect(targetDurationForRate({ sourceWindowTicks, rate: 1 })).toBe(10_000);
	});

	test("clamps rate at the 5x upper bound when target is too short", () => {
		// 10_000 / 100 = 100x desired, but max rate is 5x.
		expect(
			rateForTargetDuration({ sourceWindowTicks, targetTicks: 100 }),
		).toBe(5);
	});

	test("clamps rate at the 0.01x lower bound when target is too long", () => {
		// 10_000 / 10_000_000 = 0.001x desired, but min rate is 0.01x.
		expect(
			rateForTargetDuration({
				sourceWindowTicks,
				targetTicks: 10_000_000,
			}),
		).toBe(0.01);
	});

	test("targetDurationForRate honours the same clamp bounds", () => {
		// Rate above 5x is clamped to 5x -> shortest reachable duration.
		expect(targetDurationForRate({ sourceWindowTicks, rate: 50 })).toBe(2_000);
		// Rate below 0.01x is clamped to 0.01x -> longest reachable duration.
		expect(targetDurationForRate({ sourceWindowTicks, rate: 0.0001 })).toBe(
			1_000_000,
		);
	});

	test("round-trips duration -> rate -> duration within the legal range", () => {
		const targetTicks = 4_000; // implies 2.5x, inside [0.01, 5].
		const rate = rateForTargetDuration({ sourceWindowTicks, targetTicks });
		expect(rate).toBe(2.5);
		expect(targetDurationForRate({ sourceWindowTicks, rate })).toBe(targetTicks);
	});

	test("round-trips rate -> duration -> rate", () => {
		const rate = 1.25;
		const duration = targetDurationForRate({ sourceWindowTicks, rate });
		expect(
			rateForTargetDuration({ sourceWindowTicks, targetTicks: duration }),
		).toBe(rate);
	});

	test("non-positive source window yields zero duration", () => {
		expect(targetDurationForRate({ sourceWindowTicks: 0, rate: 2 })).toBe(0);
		expect(targetDurationForRate({ sourceWindowTicks: -5, rate: 2 })).toBe(0);
	});

	test("non-finite inputs fall back to a safe in-range rate", () => {
		// Division-by-zero / NaN must not escape the clamp.
		expect(
			rateForTargetDuration({ sourceWindowTicks, targetTicks: 0 }),
		).toBe(1);
		expect(
			rateForTargetDuration({ sourceWindowTicks: NaN, targetTicks: 5_000 }),
		).toBe(1);
	});
});
