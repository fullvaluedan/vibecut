import { describe, expect, test } from "bun:test";
import { computeSlipTarget } from "../slip";

// A 1-second clip at 120_000 ticks/second, sourced from the MIDDLE of a longer
// file so there is slack on both sides to slip into: duration 100k, source 300k,
// trimStart 100k, trimEnd 100k (visible span 100k == duration at rate 1). The
// freed window is sourceDuration - duration*rate == 300k - 100k == 200k, so
// trimStart can range over [0, 200k].
const base = {
	trimStartTicks: 100_000,
	trimEndTicks: 100_000,
	sourceDurationTicks: 300_000,
	durationTicks: 100_000,
	deltaTicks: 0,
	rate: 1,
};

describe("computeSlipTarget", () => {
	test("positive delta moves trimStart up / trimEnd down by sourceDelta", () => {
		// +30k: trimStart 100k -> 130k, trimEnd 100k -> 70k. Visible span unchanged.
		const result = computeSlipTarget({ ...base, deltaTicks: 30_000 });
		expect(result).toEqual({
			trimStartTicks: 130_000,
			trimEndTicks: 70_000,
		});
	});

	test("negative delta moves trimStart down / trimEnd up by sourceDelta", () => {
		// -30k: trimStart 100k -> 70k, trimEnd 100k -> 130k.
		const result = computeSlipTarget({ ...base, deltaTicks: -30_000 });
		expect(result).toEqual({
			trimStartTicks: 70_000,
			trimEndTicks: 130_000,
		});
	});

	test("upper clamp: a huge +delta caps trimStart at windowSize, trimEnd at 0", () => {
		// windowSize = 300k - 100k = 200k. A +500k drag would push trimStart to 600k
		// (off the end of the source) — the missing-clamp bug. It must cap at 200k.
		const result = computeSlipTarget({ ...base, deltaTicks: 500_000 });
		expect(result.trimStartTicks).toBe(200_000);
		expect(result.trimEndTicks).toBe(0);
		// The visible span stays exactly duration*rate and is NEVER negative:
		// trimStart + visibleSpan + trimEnd == sourceDuration.
		const visibleSpan =
			base.sourceDurationTicks - result.trimStartTicks - result.trimEndTicks;
		expect(visibleSpan).toBe(100_000);
		expect(visibleSpan).toBeGreaterThanOrEqual(0);
	});

	test("lower clamp: a huge -delta caps trimStart at 0, trimEnd at windowSize", () => {
		// A -500k drag would push trimStart negative; it must floor at 0, handing the
		// whole window to trimEnd (200k).
		const result = computeSlipTarget({ ...base, deltaTicks: -500_000 });
		expect(result.trimStartTicks).toBe(0);
		expect(result.trimEndTicks).toBe(200_000);
		const visibleSpan =
			base.sourceDurationTicks - result.trimStartTicks - result.trimEndTicks;
		expect(visibleSpan).toBe(100_000);
	});

	test("upper clamp from a near-saturated trimStart: visible span never negative", () => {
		// trimStart already 180k (window 200k); +50k would overshoot to 230k. Caps at
		// 200k, so the actual shift is only 20k and trimEnd 20k -> 0.
		const result = computeSlipTarget({
			...base,
			trimStartTicks: 180_000,
			trimEndTicks: 20_000,
			deltaTicks: 50_000,
		});
		expect(result.trimStartTicks).toBe(200_000);
		expect(result.trimEndTicks).toBe(0);
		const visibleSpan =
			base.sourceDurationTicks - result.trimStartTicks - result.trimEndTicks;
		expect(visibleSpan).toBe(100_000);
		expect(visibleSpan).toBeGreaterThanOrEqual(0);
	});

	test("retimed rate 0.5: sourceDelta scales by the rate", () => {
		// rate 0.5: visible span = duration*rate = 50k, window = 300k - 50k = 250k
		// (plenty of room). +40k timeline drag -> sourceDelta = 40k * 0.5 = 20k.
		const result = computeSlipTarget({
			...base,
			rate: 0.5,
			deltaTicks: 40_000,
		});
		expect(result.trimStartTicks).toBe(120_000); // 100k + 20k
		expect(result.trimEndTicks).toBe(80_000); // 100k - 20k
		// Slip preserves the residual visible span: the two trims move by the same
		// source amount, so source - trimStart - trimEnd is unchanged.
		const before = base.trimStartTicks + base.trimEndTicks;
		const after = result.trimStartTicks + result.trimEndTicks;
		expect(after).toBe(before);
	});

	test("retimed rate 2: sourceDelta scales by the rate (from a clip with head room)", () => {
		// rate 2: visible span = duration*rate = 200k, window = 300k - 200k = 100k.
		// A self-consistent rate-2 clip: trimStart 0, trimEnd 100k (0 + 200k + 100k
		// == 300k). A +30k drag has sourceDelta = 30k*2 = 60k, within the window.
		const result = computeSlipTarget({
			...base,
			rate: 2,
			trimStartTicks: 0,
			trimEndTicks: 100_000,
			deltaTicks: 30_000,
		});
		expect(result.trimStartTicks).toBe(60_000); // 0 + 60k
		expect(result.trimEndTicks).toBe(40_000); // 100k - 60k
		// Visible span stays the FIXED duration*rate (200k).
		const visibleSpan =
			base.sourceDurationTicks - result.trimStartTicks - result.trimEndTicks;
		expect(visibleSpan).toBe(base.durationTicks * 2);
	});

	test("retimed rate 2 upper clamp: window shrinks with the bigger visible span", () => {
		// rate 2: window = 300k - 200k = 100k. From trimStart 0, an out-of-range
		// drag must cap trimStart at the (smaller) 100k window, trimEnd at 0.
		const clamped = computeSlipTarget({
			...base,
			rate: 2,
			trimStartTicks: 0,
			trimEndTicks: 100_000,
			deltaTicks: 9_000_000,
		});
		expect(clamped.trimStartTicks).toBe(100_000);
		expect(clamped.trimEndTicks).toBe(0);
		const visibleSpan =
			base.sourceDurationTicks - clamped.trimStartTicks - clamped.trimEndTicks;
		expect(visibleSpan).toBe(base.durationTicks * 2);
		expect(visibleSpan).toBeGreaterThanOrEqual(0);
	});

	test("zero delta is a no-op", () => {
		const result = computeSlipTarget({ ...base, deltaTicks: 0 });
		expect(result).toEqual({
			trimStartTicks: 100_000,
			trimEndTicks: 100_000,
		});
	});

	test("round-trip recovers the original trim", () => {
		const forward = computeSlipTarget({ ...base, deltaTicks: 30_000 });
		const back = computeSlipTarget({
			...base,
			trimStartTicks: forward.trimStartTicks,
			trimEndTicks: forward.trimEndTicks,
			deltaTicks: -30_000,
		});
		expect(back).toEqual({
			trimStartTicks: 100_000,
			trimEndTicks: 100_000,
		});
	});

	test("rate defaults to 1 when omitted", () => {
		const result = computeSlipTarget({
			trimStartTicks: 100_000,
			trimEndTicks: 100_000,
			sourceDurationTicks: 300_000,
			durationTicks: 100_000,
			deltaTicks: 25_000,
		});
		expect(result).toEqual({
			trimStartTicks: 125_000,
			trimEndTicks: 75_000,
		});
	});

	test("an invalid (non-positive) rate falls back to 1x via clampRetimeRate", () => {
		const result = computeSlipTarget({ ...base, rate: 0, deltaTicks: 30_000 });
		// rate 0 -> clamped to 1: sourceDelta == deltaTicks.
		expect(result).toEqual({
			trimStartTicks: 130_000,
			trimEndTicks: 70_000,
		});
	});

	test("invariant: trimStart + visibleSpan + trimEnd == sourceDuration after a slip", () => {
		const result = computeSlipTarget({ ...base, deltaTicks: 45_000 });
		const visibleSpan =
			base.sourceDurationTicks - result.trimStartTicks - result.trimEndTicks;
		expect(
			result.trimStartTicks + visibleSpan + result.trimEndTicks,
		).toBe(base.sourceDurationTicks);
		// And the visible span equals the FIXED duration*rate.
		expect(visibleSpan).toBe(base.durationTicks * base.rate);
	});

	test("degenerate: a clip with no slack (window 0) cannot slip", () => {
		// Source == visible span: window = 0, so trimStart/trimEnd are pinned.
		const result = computeSlipTarget({
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 100_000,
			durationTicks: 100_000,
			deltaTicks: 50_000,
			rate: 1,
		});
		expect(result).toEqual({ trimStartTicks: 0, trimEndTicks: 0 });
	});
});
