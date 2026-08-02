import type { RetimeConfig } from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";
import {
	averageRetimeCurveRate,
	retimeCurveRateAtFraction,
	sourceTimeAtCurveClipTime,
} from "@/retime/curve";

function getSafeRate({ rate }: { rate: number }): number {
	return clampRetimeRate({ rate });
}

/**
 * T18.2: the rate used for SPAN <-> DURATION bookkeeping (trim, split,
 * duration re-derivation) as opposed to per-frame sampling. For a constant
 * rate this is just the rate itself; for a curve it's the curve's average
 * rate over its own 0..1 domain, which - because curve points are fixed
 * FRACTIONS of clip duration - is independent of the clip's actual duration
 * (see the module comment on `averageRetimeCurveRate` in retime/curve.ts).
 * That single property is what lets every span/duration conversion below
 * stay a plain division, curve or not: `sourceSpan(T) = T * getSpanRate(...)`
 * holds exactly for any `T`.
 */
function getSpanRate({ retime }: { retime?: RetimeConfig }): number {
	if (retime?.curve) {
		return averageRetimeCurveRate({ curve: retime.curve });
	}
	return getSafeRate({ rate: retime?.rate ?? 1 });
}

/**
 * T18.1 reverse / T18.2 curve: source offset within the trimmed span at a
 * given clip time.
 *
 * Curve (T18.2): when `retime.curve` is set it supersedes `rate` entirely -
 * the source offset is the curve's exact piecewise-linear integral up to
 * `clipTime` (see `sourceTimeAtCurveClipTime`). This needs `clipDuration` to
 * turn `clipTime` into a curve fraction; without it (an older call site that
 * never threads clipDuration through) this falls back to the span-rate
 * approximation (`clipTime * averageRetimeCurveRate`) - exact at the clip's
 * own duration-independent average, just not frame-exact mid-clip. Every
 * renderer/preview/export sampling call site passes clipDuration (see
 * services/renderer/resolve.ts), so this fallback only matters for
 * bookkeeping call sites that already only need the average anyway
 * (waveform preview, live audio scheduling).
 *
 * Reverse (T18.1): forward playback reads the span front-to-back
 * (`clipTime * rate`). Reverse reads it back-to-front: at `clipTime = 0` it
 * lands on the LAST sample of the span, at `clipTime = clipDuration` it
 * approaches the FIRST. This mirrors the forward formula's own boundary
 * shape (see the module comment on `getEffectiveRateAt`), so a clip split at
 * any point stays frame-continuous across the cut (verified in
 * retime/__tests__/reverse.test.ts). Curve and reversed are never combined
 * (see the RetimeConfig.curve doc comment in timeline/types.ts), so the
 * curve branch above always wins when both would otherwise apply.
 *
 * `clipDuration` is required for reverse - without it (older call sites that
 * never pass it) reverse silently falls back to forward, which is always
 * safe because `retime.reversed` only ever gets set by the T18.1 Speed-tab
 * toggle, and every UI path that sets it also threads clipDuration through.
 */
export function getSourceTimeAtClipTime({
	clipTime,
	retime,
	clipDuration,
}: {
	clipTime: number;
	retime?: RetimeConfig;
	clipDuration?: number;
}): number {
	if (retime?.curve) {
		if (clipDuration !== undefined && clipDuration > 0) {
			return sourceTimeAtCurveClipTime({
				clipTime,
				curve: retime.curve,
				clipDuration,
			});
		}
		return clipTime * averageRetimeCurveRate({ curve: retime.curve });
	}
	const rate = getSafeRate({ rate: retime?.rate ?? 1 });
	if (retime?.reversed === true && clipDuration !== undefined) {
		return Math.max(0, clipDuration - clipTime) * rate;
	}
	return clipTime * rate;
}

export function getClipTimeAtSourceTime({
	sourceTime,
	retime,
}: {
	sourceTime: number;
	retime?: RetimeConfig;
}): number {
	return sourceTime / getSpanRate({ retime });
}

/** Instantaneous rate: the curve's rate at the given clip-time fraction when
 * a curve is active (falls back to the flat average when `clipTime`/duration
 * context isn't available), otherwise the constant rate. Not used by the
 * integration math itself (which works off cumulative area), only by
 * callers that want a single "how fast right now" number. */
export function getEffectiveRateAt({
	retime,
	clipTime,
	clipDuration,
}: {
	clipTime?: number;
	clipDuration?: number;
	retime?: RetimeConfig;
}): number {
	if (retime?.curve) {
		if (clipTime !== undefined && clipDuration !== undefined && clipDuration > 0) {
			return retimeCurveRateAtFraction({
				curve: retime.curve,
				fraction: clipTime / clipDuration,
			});
		}
		return averageRetimeCurveRate({ curve: retime.curve });
	}
	return getSafeRate({ rate: retime?.rate ?? 1 });
}

export function getTimelineDurationForSourceSpan({
	sourceSpan,
	retime,
}: {
	sourceSpan: number;
	retime?: RetimeConfig;
}): number {
	if (sourceSpan <= 0) {
		return 0;
	}
	return sourceSpan / getSpanRate({ retime });
}
