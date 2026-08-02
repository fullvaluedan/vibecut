import { MAX_RETIME_RATE, MIN_RETIME_RATE, clampRetimeRate } from "@/retime/rate";

/**
 * T18.2 speed curves: a piecewise-linear speed profile over clip-time
 * FRACTION (0..1), not absolute seconds. `t` is where a point sits within
 * the clip's own duration; `rate` is the instantaneous speed multiplier at
 * that point. Linear interpolation between consecutive points gives the
 * rate at any fraction in between - this is what CapCut's curves are under
 * the hood, and it keeps every integral below closed-form (a trapezoid per
 * segment, no numerical approximation).
 */
export interface RetimeCurvePoint {
	t: number;
	rate: number;
}

export interface RetimeCurve {
	points: RetimeCurvePoint[];
}

export const MIN_CURVE_POINTS = 2;
export const MAX_CURVE_POINTS = 10;

/** Minimum gap enforced between two points' `t` when normalizing/sanitizing
 * so no segment ever has zero width (which would make its slope undefined). */
const MIN_T_GAP = 1e-6;

/**
 * Sanitizes an arbitrary point list (drag input, a preset, a loaded project)
 * into a valid curve: sorted by `t`, 2..10 points, `t` strictly increasing
 * with the first point pinned to 0 and the last to 1, rates clamped to the
 * same [MIN_RETIME_RATE, MAX_RETIME_RATE] range constant-rate retime uses.
 * Never throws - every caller (UI drag, preset apply, project load) always
 * gets back something safe to integrate and render.
 */
export function normalizeRetimeCurve({
	points,
}: {
	points: RetimeCurvePoint[];
}): RetimeCurve {
	const finite = points.filter(
		(point) => Number.isFinite(point.t) && Number.isFinite(point.rate),
	);
	const sorted = [...finite].sort((a, b) => a.t - b.t).slice(0, MAX_CURVE_POINTS);
	const clamped = sorted.map((point) => ({
		t: Math.min(1, Math.max(0, point.t)),
		rate: clampRetimeRate({ rate: point.rate }),
	}));

	for (let i = 1; i < clamped.length; i++) {
		if (clamped[i].t <= clamped[i - 1].t) {
			clamped[i] = {
				...clamped[i],
				t: Math.min(1, clamped[i - 1].t + MIN_T_GAP),
			};
		}
	}

	if (clamped.length < MIN_CURVE_POINTS) {
		return {
			points: [
				{ t: 0, rate: 1 },
				{ t: 1, rate: 1 },
			],
		};
	}

	clamped[0] = { ...clamped[0], t: 0 };
	clamped[clamped.length - 1] = { ...clamped[clamped.length - 1], t: 1 };
	return { points: clamped };
}

/**
 * Strict validity check (as opposed to `normalizeRetimeCurve`'s "always
 * produce something usable"): 2..10 points, `t` strictly increasing from 0
 * to 1, every rate within [MIN_RETIME_RATE, MAX_RETIME_RATE]. Used by the UI
 * to reject a malformed curve rather than silently reshape it, and by tests
 * to assert every preset and every sanitized drag result is well-formed.
 */
export function isValidRetimeCurve({ curve }: { curve: RetimeCurve }): boolean {
	const { points } = curve;
	if (points.length < MIN_CURVE_POINTS || points.length > MAX_CURVE_POINTS) {
		return false;
	}
	if (points[0].t !== 0 || points[points.length - 1].t !== 1) {
		return false;
	}
	const rateEpsilon = 1e-9;
	for (let i = 0; i < points.length; i++) {
		const point = points[i];
		if (!Number.isFinite(point.t) || !Number.isFinite(point.rate)) {
			return false;
		}
		if (
			point.rate < MIN_RETIME_RATE - rateEpsilon ||
			point.rate > MAX_RETIME_RATE + rateEpsilon
		) {
			return false;
		}
		if (i > 0 && point.t <= points[i - 1].t) {
			return false;
		}
	}
	return true;
}

/**
 * Cumulative area under the piecewise-linear rate curve from fraction 0 to
 * fraction `f` (the trapezoid rule, EXACT here rather than an approximation
 * because the curve itself is piecewise linear - every segment's integral
 * has a closed form: `(rateStart + rateEnd) / 2 * width`).
 */
function cumulativeArea({ curve, f }: { curve: RetimeCurve; f: number }): number {
	const points = curve.points;
	const clampedF = Math.min(1, Math.max(0, f));
	let area = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const start = points[i];
		const end = points[i + 1];
		if (clampedF <= start.t) break;
		const segmentWidth = end.t - start.t;
		if (segmentWidth <= 0) continue;
		const segmentEnd = Math.min(clampedF, end.t);
		const span = segmentEnd - start.t;
		const rateAtSegmentEnd =
			start.rate + (end.rate - start.rate) * (span / segmentWidth);
		area += ((start.rate + rateAtSegmentEnd) / 2) * span;
		if (clampedF < end.t) break;
	}
	return area;
}

/**
 * The curve's average rate across its whole 0..1 domain (`cumulativeArea`
 * at f=1). Because curve points are fixed FRACTIONS of clip duration - not
 * fixed real-time offsets - this average is independent of the clip's
 * actual duration: stretching or shrinking the clip rescales which real
 * times map to which fractions, but the area under the curve over its own
 * normalized domain doesn't change. That single fact is what keeps duration
 * re-derivation, trim, and split all closed-form for curves (see
 * `clipDurationForCurveSourceSpan` below and the `getSpanRate` note in
 * resolve.ts) - no iterative root-finding anywhere in this module.
 */
export function averageRetimeCurveRate({ curve }: { curve: RetimeCurve }): number {
	return cumulativeArea({ curve, f: 1 });
}

/**
 * T18.2 renderer/preview sampling: the source-time offset within the
 * trimmed span at a given clip time, for a curve retime. Exact per segment
 * (see `cumulativeArea`) and monotonic in `clipTime` as long as every rate
 * stays positive (guaranteed - rates are clamped to
 * `[MIN_RETIME_RATE, MAX_RETIME_RATE]`, both > 0), so two frames never read
 * the same or an out-of-order source instant.
 */
export function sourceTimeAtCurveClipTime({
	clipTime,
	curve,
	clipDuration,
}: {
	clipTime: number;
	curve: RetimeCurve;
	clipDuration: number;
}): number {
	if (clipDuration <= 0) return 0;
	const fraction = clipTime / clipDuration;
	return clipDuration * cumulativeArea({ curve, f: fraction });
}

/**
 * Inversion of `sourceTimeAtCurveClipTime`, needed wherever a target
 * VISIBLE SOURCE SPAN (trim-derived, not a specific clip time) has to be
 * turned back into a clip duration - the curve analogue of
 * `getTimelineDurationForSourceSpan`. Because the curve's average rate is
 * duration-independent (see `averageRetimeCurveRate`), `sourceSpan(T) = T *
 * avgRate` holds for every `T`, so this inverts exactly with a single
 * division - no search needed.
 */
export function clipDurationForCurveSourceSpan({
	sourceSpan,
	curve,
}: {
	sourceSpan: number;
	curve: RetimeCurve;
}): number {
	if (sourceSpan <= 0) return 0;
	const avgRate = averageRetimeCurveRate({ curve });
	if (avgRate <= 0) return 0;
	return sourceSpan / avgRate;
}

/** Instantaneous rate at a given clip-time fraction (linear interpolation
 * between the two bracketing points). Used by the graph UI to read back a
 * rate for display; not used by the integration math above, which works
 * directly off cumulative area. */
export function retimeCurveRateAtFraction({
	curve,
	fraction,
}: {
	curve: RetimeCurve;
	fraction: number;
}): number {
	const points = curve.points;
	const clamped = Math.min(1, Math.max(0, fraction));
	for (let i = 0; i < points.length - 1; i++) {
		const start = points[i];
		const end = points[i + 1];
		if (clamped >= start.t && clamped <= end.t) {
			const segmentWidth = end.t - start.t;
			if (segmentWidth <= 0) return start.rate;
			return (
				start.rate + (end.rate - start.rate) * ((clamped - start.t) / segmentWidth)
			);
		}
	}
	return points[points.length - 1]?.rate ?? 1;
}
