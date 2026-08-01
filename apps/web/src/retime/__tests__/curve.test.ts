import { describe, expect, test } from "bun:test";
import {
	MAX_CURVE_POINTS,
	MIN_CURVE_POINTS,
	averageRetimeCurveRate,
	clipDurationForCurveSourceSpan,
	isValidRetimeCurve,
	normalizeRetimeCurve,
	retimeCurveRateAtFraction,
	sourceTimeAtCurveClipTime,
	type RetimeCurve,
} from "@/retime/curve";
import { MAX_RETIME_RATE, MIN_RETIME_RATE } from "@/retime/rate";

// A simple triangle: 1x -> 3x -> 1x. Every expected value below is worked out
// by hand from the trapezoid rule so the tests check real numbers, not just
// self-consistency.
const triangle: RetimeCurve = {
	points: [
		{ t: 0, rate: 1 },
		{ t: 0.5, rate: 3 },
		{ t: 1, rate: 1 },
	],
};

describe("cumulative integration (sourceTimeAtCurveClipTime)", () => {
	test("at the first inflection point (t=0.5): trapezoid area of segment one", () => {
		// (1 + 3) / 2 * 0.5 = 1
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 5, curve: triangle, clipDuration: 10 }),
		).toBeCloseTo(10, 10);
	});

	test("at the end (t=1): both segments summed", () => {
		// segment one: 1, segment two: (3 + 1) / 2 * 0.5 = 1 -> total area 2
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 10, curve: triangle, clipDuration: 10 }),
		).toBeCloseTo(20, 10);
	});

	test("segment-one midpoint (t=0.25): partial trapezoid with the interpolated end rate", () => {
		// rate at t=0.25 interpolates to 2; area = (1 + 2) / 2 * 0.25 = 0.375
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 2.5, curve: triangle, clipDuration: 10 }),
		).toBeCloseTo(3.75, 10);
	});

	test("segment-two midpoint (t=0.75): full segment one plus a partial segment two", () => {
		// rate at t=0.75 interpolates to 2; partial area = (3 + 2) / 2 * 0.25 = 0.625
		// total = 1 (segment one) + 0.625 = 1.625
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 7.5, curve: triangle, clipDuration: 10 }),
		).toBeCloseTo(16.25, 10);
	});

	test("clipTime 0 always reads source time 0", () => {
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 0, curve: triangle, clipDuration: 10 }),
		).toBe(0);
	});

	test("a flat 1x curve is equivalent to constant-rate retime", () => {
		const flat: RetimeCurve = {
			points: [
				{ t: 0, rate: 1 },
				{ t: 1, rate: 1 },
			],
		};
		for (const clipTime of [0, 2, 5, 8, 10]) {
			expect(
				sourceTimeAtCurveClipTime({ clipTime, curve: flat, clipDuration: 10 }),
			).toBeCloseTo(clipTime, 10);
		}
	});

	test("a flat constant-rate curve scales linearly, matching a plain rate", () => {
		const flatTwoX: RetimeCurve = {
			points: [
				{ t: 0, rate: 2 },
				{ t: 1, rate: 2 },
			],
		};
		for (const clipTime of [0, 3, 6, 10]) {
			expect(
				sourceTimeAtCurveClipTime({ clipTime, curve: flatTwoX, clipDuration: 10 }),
			).toBeCloseTo(clipTime * 2, 10);
		}
	});

	test("zero or negative clip duration reads source time 0 (never divides by zero)", () => {
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 5, curve: triangle, clipDuration: 0 }),
		).toBe(0);
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 5, curve: triangle, clipDuration: -1 }),
		).toBe(0);
	});
});

describe("monotonicity", () => {
	test("source time never decreases and never repeats as clip time advances", () => {
		const clipDuration = 12;
		let previous = -1;
		for (let ticks = 0; ticks <= 240; ticks++) {
			const clipTime = (ticks / 240) * clipDuration;
			const sourceTime = sourceTimeAtCurveClipTime({
				clipTime,
				curve: triangle,
				clipDuration,
			});
			expect(sourceTime).toBeGreaterThanOrEqual(previous);
			previous = sourceTime;
		}
	});

	test("holds for a curve with points at every extreme rate", () => {
		const extreme: RetimeCurve = {
			points: [
				{ t: 0, rate: MIN_RETIME_RATE },
				{ t: 0.3, rate: MAX_RETIME_RATE },
				{ t: 0.6, rate: MIN_RETIME_RATE },
				{ t: 1, rate: MAX_RETIME_RATE },
			],
		};
		const clipDuration = 20;
		let previous = -1;
		for (let ticks = 0; ticks <= 400; ticks++) {
			const clipTime = (ticks / 400) * clipDuration;
			const sourceTime = sourceTimeAtCurveClipTime({
				clipTime,
				curve: extreme,
				clipDuration,
			});
			expect(sourceTime).toBeGreaterThanOrEqual(previous);
			previous = sourceTime;
		}
	});
});

describe("average rate and duration inversion (closed-form, no root-finding)", () => {
	test("triangle's average rate is the mean of its two segment areas", () => {
		expect(averageRetimeCurveRate({ curve: triangle })).toBeCloseTo(2, 10);
	});

	test("a flat curve's average rate equals its constant rate", () => {
		const flatHalf: RetimeCurve = {
			points: [
				{ t: 0, rate: 0.5 },
				{ t: 1, rate: 0.5 },
			],
		};
		expect(averageRetimeCurveRate({ curve: flatHalf })).toBeCloseTo(0.5, 10);
	});

	test("clipDurationForCurveSourceSpan inverts sourceSpan = duration * avgRate exactly", () => {
		const avgRate = averageRetimeCurveRate({ curve: triangle });
		for (const duration of [1, 5, 9.5, 30]) {
			const sourceSpan = duration * avgRate;
			expect(
				clipDurationForCurveSourceSpan({ sourceSpan, curve: triangle }),
			).toBeCloseTo(duration, 10);
		}
	});

	test("round-trips through sourceTimeAtCurveClipTime at the full-duration boundary", () => {
		for (const clipDuration of [4, 10, 33.3]) {
			const fullSourceSpan = sourceTimeAtCurveClipTime({
				clipTime: clipDuration,
				curve: triangle,
				clipDuration,
			});
			expect(
				clipDurationForCurveSourceSpan({ sourceSpan: fullSourceSpan, curve: triangle }),
			).toBeCloseTo(clipDuration, 8);
		}
	});

	test("duration re-derivation is independent of the ORIGINAL duration (fraction-domain curve)", () => {
		// Stretching or shrinking a curve-retimed clip rescales which real times
		// map to which curve fractions; the average rate - and therefore the
		// span<->duration relationship - stays the same regardless.
		const avgRate = averageRetimeCurveRate({ curve: triangle });
		expect(
			clipDurationForCurveSourceSpan({ sourceSpan: avgRate * 3, curve: triangle }),
		).toBeCloseTo(3, 10);
		expect(
			clipDurationForCurveSourceSpan({ sourceSpan: avgRate * 300, curve: triangle }),
		).toBeCloseTo(300, 10);
	});

	test("non-positive source span derives to zero duration", () => {
		expect(clipDurationForCurveSourceSpan({ sourceSpan: 0, curve: triangle })).toBe(0);
		expect(clipDurationForCurveSourceSpan({ sourceSpan: -5, curve: triangle })).toBe(0);
	});
});

describe("retimeCurveRateAtFraction", () => {
	test("returns exact point rates at point fractions", () => {
		expect(retimeCurveRateAtFraction({ curve: triangle, fraction: 0 })).toBe(1);
		expect(retimeCurveRateAtFraction({ curve: triangle, fraction: 0.5 })).toBe(3);
		expect(retimeCurveRateAtFraction({ curve: triangle, fraction: 1 })).toBe(1);
	});

	test("interpolates linearly between points", () => {
		expect(retimeCurveRateAtFraction({ curve: triangle, fraction: 0.25 })).toBeCloseTo(
			2,
			10,
		);
		expect(retimeCurveRateAtFraction({ curve: triangle, fraction: 0.75 })).toBeCloseTo(
			2,
			10,
		);
	});

	test("clamps out-of-range fractions to the endpoints", () => {
		expect(retimeCurveRateAtFraction({ curve: triangle, fraction: -1 })).toBe(1);
		expect(retimeCurveRateAtFraction({ curve: triangle, fraction: 2 })).toBe(1);
	});
});

describe("isValidRetimeCurve", () => {
	test("accepts a well-formed curve", () => {
		expect(isValidRetimeCurve({ curve: triangle })).toBe(true);
	});

	test("rejects too few or too many points", () => {
		expect(
			isValidRetimeCurve({ curve: { points: [{ t: 0, rate: 1 }] } }),
		).toBe(false);
		const tooMany: RetimeCurve = {
			points: Array.from({ length: MAX_CURVE_POINTS + 1 }, (_, i) => ({
				t: i / (MAX_CURVE_POINTS + 1),
				rate: 1,
			})),
		};
		expect(isValidRetimeCurve({ curve: tooMany })).toBe(false);
	});

	test("rejects endpoints not pinned to 0 and 1", () => {
		expect(
			isValidRetimeCurve({
				curve: {
					points: [
						{ t: 0.1, rate: 1 },
						{ t: 1, rate: 1 },
					],
				},
			}),
		).toBe(false);
		expect(
			isValidRetimeCurve({
				curve: {
					points: [
						{ t: 0, rate: 1 },
						{ t: 0.9, rate: 1 },
					],
				},
			}),
		).toBe(false);
	});

	test("rejects non-increasing t", () => {
		expect(
			isValidRetimeCurve({
				curve: {
					points: [
						{ t: 0, rate: 1 },
						{ t: 0.5, rate: 2 },
						{ t: 0.5, rate: 1 },
						{ t: 1, rate: 1 },
					],
				},
			}),
		).toBe(false);
	});

	test("rejects rates outside [MIN_RETIME_RATE, MAX_RETIME_RATE]", () => {
		expect(
			isValidRetimeCurve({
				curve: {
					points: [
						{ t: 0, rate: 0 },
						{ t: 1, rate: 1 },
					],
				},
			}),
		).toBe(false);
		expect(
			isValidRetimeCurve({
				curve: {
					points: [
						{ t: 0, rate: 1 },
						{ t: 1, rate: MAX_RETIME_RATE + 1 },
					],
				},
			}),
		).toBe(false);
	});
});

describe("normalizeRetimeCurve", () => {
	test("sorts, clamps rates, and pins endpoints to 0 and 1", () => {
		const result = normalizeRetimeCurve({
			points: [
				{ t: 0.5, rate: 2 },
				{ t: 0.1, rate: -1 },
				{ t: 0.9, rate: 999 },
			],
		});
		expect(isValidRetimeCurve({ curve: result })).toBe(true);
		expect(result.points[0].t).toBe(0);
		expect(result.points[result.points.length - 1].t).toBe(1);
		expect(result.points.every((p) => p.rate >= MIN_RETIME_RATE)).toBe(true);
		expect(result.points.every((p) => p.rate <= MAX_RETIME_RATE)).toBe(true);
	});

	test("de-duplicates identical t values by nudging forward, keeping order", () => {
		const result = normalizeRetimeCurve({
			points: [
				{ t: 0, rate: 1 },
				{ t: 0.5, rate: 2 },
				{ t: 0.5, rate: 4 },
				{ t: 1, rate: 1 },
			],
		});
		expect(isValidRetimeCurve({ curve: result })).toBe(true);
		expect(result.points).toHaveLength(4);
	});

	test("caps at MAX_CURVE_POINTS", () => {
		const points = Array.from({ length: MAX_CURVE_POINTS + 5 }, (_, i) => ({
			t: i / (MAX_CURVE_POINTS + 4),
			rate: 1,
		}));
		const result = normalizeRetimeCurve({ points });
		expect(result.points.length).toBeLessThanOrEqual(MAX_CURVE_POINTS);
		expect(isValidRetimeCurve({ curve: result })).toBe(true);
	});

	test("falls back to a flat 1x curve when fewer than MIN_CURVE_POINTS survive", () => {
		const result = normalizeRetimeCurve({ points: [{ t: 0.5, rate: 2 }] });
		expect(result.points).toHaveLength(MIN_CURVE_POINTS);
		expect(isValidRetimeCurve({ curve: result })).toBe(true);
	});

	test("drops non-finite points before sorting", () => {
		const result = normalizeRetimeCurve({
			points: [
				{ t: 0, rate: 1 },
				{ t: Number.NaN, rate: 2 },
				{ t: 0.5, rate: Number.POSITIVE_INFINITY },
				{ t: 1, rate: 1 },
			],
		});
		expect(isValidRetimeCurve({ curve: result })).toBe(true);
		// Only the two finite points ({t:0} and {t:1}) survive the filter.
		expect(result.points).toHaveLength(2);
	});
});

describe("serialization round-trip", () => {
	test("a curve survives JSON.stringify/parse unchanged", () => {
		const json = JSON.parse(JSON.stringify(triangle)) as RetimeCurve;
		expect(json).toEqual(triangle);
		expect(
			sourceTimeAtCurveClipTime({ clipTime: 5, curve: json, clipDuration: 10 }),
		).toBe(
			sourceTimeAtCurveClipTime({ clipTime: 5, curve: triangle, clipDuration: 10 }),
		);
	});
});
