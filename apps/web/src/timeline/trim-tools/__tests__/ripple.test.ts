import { describe, expect, test } from "bun:test";
import {
	computeRippleTrimTarget,
	type RippleTrimTarget,
} from "../ripple";

/**
 * The source-window invariant every result must satisfy:
 *   trimStart + duration * rate + trimEnd === sourceDuration   (when not floored)
 * and the weaker, always-true form:
 *   trimStart + duration * rate + trimEnd <= sourceDuration
 *
 * NOTE on a few design edge-case rows (cases 8, 9, 18 in the spec): the spec's
 * detailed CLAMPING algorithm (saturate trims to [0,∞), then shrink duration so
 * `trimStart + duration*rate + trimEnd <= sourceDuration`) is authoritative and
 * self-consistent. A handful of the per-row NARRATIVES mis-derive the final
 * number (e.g. "shrink duration to 60_000; rippleShift=0" when the stated
 * inequality `dur <= 120_000` actually yields duration=120_000). These tests
 * assert the invariant-correct values produced by the authoritative algorithm.
 */
function expectSourceInvariant({
	result,
	sourceDuration,
	rate = 1,
}: {
	result: RippleTrimTarget;
	sourceDuration: number;
	rate?: number;
}): void {
	const consumed =
		result.trimStartTicks +
		result.durationTicks * rate +
		result.trimEndTicks;
	expect(consumed).toBeLessThanOrEqual(sourceDuration);
	expect(result.trimStartTicks).toBeGreaterThanOrEqual(0);
	expect(result.trimEndTicks).toBeGreaterThanOrEqual(0);
}

describe("computeRippleTrimTarget — right edge", () => {
	test("right edge pull (extend) — happy path", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 240_000,
			deltaTicks: 60_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(180_000);
		expect(r.trimEndTicks).toBe(0);
		expect(r.trimStartTicks).toBe(0);
		expect(r.startTimeTicks).toBe(0);
		expect(r.rippleShiftDeltaTicks).toBe(60_000);
		expect(r.rippleShiftBoundaryTicks).toBe(120_000);
		expectSourceInvariant({ result: r, sourceDuration: 240_000 });
	});

	test("right edge push (shorten) — happy path", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: -60_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(60_000);
		expect(r.trimEndTicks).toBe(60_000); // released source moves to trimEnd
		expect(r.rippleShiftDeltaTicks).toBe(-60_000);
		expect(r.rippleShiftBoundaryTicks).toBe(120_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});

	test("right edge hits minDuration clamp", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: -200_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(4_000);
		expect(r.rippleShiftDeltaTicks).toBe(-116_000);
		expect(r.rippleShiftBoundaryTicks).toBe(120_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});

	test("right edge trimEnd floor + source-extent clamp (spec case 8)", () => {
		// trimEnd=60k saturates to 0; source-extent invariant caps duration at
		// 120_000 (NOT 60_000 — the spec narrative for this row is wrong).
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 60_000,
			trimStartTicks: 0,
			trimEndTicks: 60_000,
			sourceDurationTicks: 120_000,
			deltaTicks: 100_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.trimEndTicks).toBe(0);
		expect(r.durationTicks).toBe(120_000);
		expect(r.rippleShiftDeltaTicks).toBe(60_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});

	test("right edge near source extent boundary (spec case 15)", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 100_000,
			trimStartTicks: 0,
			trimEndTicks: 20_000,
			sourceDurationTicks: 120_000,
			deltaTicks: 50_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.trimEndTicks).toBe(0);
		expect(r.durationTicks).toBe(120_000);
		expect(r.rippleShiftDeltaTicks).toBe(20_000);
		expect(r.rippleShiftBoundaryTicks).toBe(100_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});

	test("right edge very small minDuration clamp (spec case 17)", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 10_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 10_000,
			deltaTicks: -20_000,
			minDurationTicks: 1,
		})!;
		expect(r.durationTicks).toBe(1);
		expect(r.rippleShiftDeltaTicks).toBe(-9_999);
		expectSourceInvariant({ result: r, sourceDuration: 10_000 });
	});
});

describe("computeRippleTrimTarget — left edge", () => {
	test("left edge extend head — happy path", () => {
		const r = computeRippleTrimTarget({
			side: "left",
			startTimeTicks: 100_000,
			durationTicks: 120_000,
			trimStartTicks: 60_000,
			trimEndTicks: 0,
			sourceDurationTicks: 180_000,
			deltaTicks: -60_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(180_000);
		expect(r.trimStartTicks).toBe(0);
		expect(r.startTimeTicks).toBe(100_000); // anchored, unchanged
		expect(r.rippleShiftDeltaTicks).toBe(60_000);
		expect(r.rippleShiftBoundaryTicks).toBe(100_000);
		expectSourceInvariant({ result: r, sourceDuration: 180_000 });
	});

	test("left edge trim head — happy path", () => {
		const r = computeRippleTrimTarget({
			side: "left",
			startTimeTicks: 100_000,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: 60_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(60_000);
		expect(r.trimStartTicks).toBe(60_000);
		expect(r.startTimeTicks).toBe(100_000); // anchored
		expect(r.rippleShiftDeltaTicks).toBe(-60_000);
		expect(r.rippleShiftBoundaryTicks).toBe(100_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});

	test("left edge hits minDuration clamp", () => {
		const r = computeRippleTrimTarget({
			side: "left",
			startTimeTicks: 100_000,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: 200_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(4_000);
		expect(r.trimStartTicks).toBe(116_000);
		expect(r.startTimeTicks).toBe(100_000);
		expect(r.rippleShiftDeltaTicks).toBe(-116_000);
		expect(r.rippleShiftBoundaryTicks).toBe(100_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});

	test("left edge trimStart floor + source-extent clamp (spec case 9)", () => {
		// trimStart=60k saturates to 0; source-extent invariant caps duration at
		// 120_000 (NOT 60_000 — the spec narrative for this row is wrong).
		const r = computeRippleTrimTarget({
			side: "left",
			startTimeTicks: 100_000,
			durationTicks: 60_000,
			trimStartTicks: 60_000,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: -100_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.trimStartTicks).toBe(0);
		expect(r.durationTicks).toBe(120_000);
		expect(r.startTimeTicks).toBe(100_000);
		expect(r.rippleShiftDeltaTicks).toBe(60_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});

	test("left edge with existing large trimStart (spec case 16)", () => {
		const r = computeRippleTrimTarget({
			side: "left",
			startTimeTicks: 100_000,
			durationTicks: 40_000,
			trimStartTicks: 80_000,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: -50_000,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(90_000);
		expect(r.trimStartTicks).toBe(30_000);
		expect(r.rippleShiftDeltaTicks).toBe(50_000);
		expect(r.rippleShiftBoundaryTicks).toBe(100_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000 });
	});
});

describe("computeRippleTrimTarget — retimed clips", () => {
	test("rate=0.5 right edge pull (spec case 10)", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 240_000,
			deltaTicks: 60_000,
			rate: 0.5,
			minDurationTicks: 4_000,
		})!;
		// sourceEquiv = 60_000 * 0.5 = 30_000; trimEnd stays 0 (already 0).
		expect(r.durationTicks).toBe(180_000);
		expect(r.trimEndTicks).toBe(0);
		expect(r.rippleShiftDeltaTicks).toBe(60_000);
		expectSourceInvariant({ result: r, sourceDuration: 240_000, rate: 0.5 });
	});

	test("rate=2 left edge trim head (spec case 11)", () => {
		const r = computeRippleTrimTarget({
			side: "left",
			startTimeTicks: 100_000,
			durationTicks: 60_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: 30_000,
			rate: 2,
			minDurationTicks: 4_000,
		})!;
		// sourceEquiv = 30_000 * 2 = 60_000; new trimStart = 60_000.
		expect(r.durationTicks).toBe(30_000);
		expect(r.trimStartTicks).toBe(60_000);
		expect(r.startTimeTicks).toBe(100_000);
		expect(r.rippleShiftDeltaTicks).toBe(-30_000);
		// source extent: 60_000 + 30_000*2 + 0 = 120_000 == sourceDuration
		expectSourceInvariant({ result: r, sourceDuration: 120_000, rate: 2 });
	});

	test("rate=0.5 right edge push (shorten) releases source to trimEnd", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: -40_000,
			rate: 0.5,
			minDurationTicks: 4_000,
		})!;
		// sourceEquiv = -40_000 * 0.5 = -20_000; trimEnd = 0 - (-20_000) = 20_000.
		expect(r.durationTicks).toBe(80_000);
		expect(r.trimEndTicks).toBe(20_000);
		expect(r.rippleShiftDeltaTicks).toBe(-40_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000, rate: 0.5 });
	});

	test("rate=5 right edge pull saturates on source extent (spec case 18)", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: 60_000,
			rate: 5,
			minDurationTicks: 4_000,
		})!;
		// sourceEquiv = 300_000; trimEnd floors at 0; duration capped at
		// floor(120_000 / 5) = 24_000.
		expect(r.trimEndTicks).toBe(0);
		expect(r.durationTicks).toBe(24_000);
		expect(r.rippleShiftDeltaTicks).toBe(-96_000);
		expectSourceInvariant({ result: r, sourceDuration: 120_000, rate: 5 });
	});
});

describe("computeRippleTrimTarget — degenerate / null cases", () => {
	test("zero delta is a no-op (right edge)", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 120_000,
			deltaTicks: 0,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(120_000);
		expect(r.trimStartTicks).toBe(0);
		expect(r.trimEndTicks).toBe(0);
		expect(r.startTimeTicks).toBe(0);
		expect(r.rippleShiftDeltaTicks).toBe(0);
		expect(r.rippleShiftBoundaryTicks).toBe(120_000);
	});

	test("zero delta is a no-op (left edge, boundary is startTime)", () => {
		const r = computeRippleTrimTarget({
			side: "left",
			startTimeTicks: 100_000,
			durationTicks: 120_000,
			trimStartTicks: 10_000,
			trimEndTicks: 5_000,
			sourceDurationTicks: 200_000,
			deltaTicks: 0,
			minDurationTicks: 4_000,
		})!;
		expect(r.durationTicks).toBe(120_000);
		expect(r.trimStartTicks).toBe(10_000);
		expect(r.trimEndTicks).toBe(5_000);
		expect(r.rippleShiftDeltaTicks).toBe(0);
		expect(r.rippleShiftBoundaryTicks).toBe(100_000);
	});

	test("no source window (trims consume all source) returns null", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 60_000,
			trimEndTicks: 60_000,
			sourceDurationTicks: 120_000,
			deltaTicks: 60_000,
			minDurationTicks: 4_000,
		});
		expect(r).toBeNull();
	});

	test("missing/zero sourceDuration (generated element) returns null", () => {
		const r = computeRippleTrimTarget({
			side: "right",
			startTimeTicks: 0,
			durationTicks: 120_000,
			trimStartTicks: 0,
			trimEndTicks: 0,
			sourceDurationTicks: 0,
			deltaTicks: 60_000,
			minDurationTicks: 4_000,
		});
		expect(r).toBeNull();
	});
});
