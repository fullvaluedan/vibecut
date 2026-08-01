import type { RetimeConfig } from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";

function getSafeRate({ rate }: { rate: number }): number {
	return clampRetimeRate({ rate });
}

/**
 * T18.1 reverse: source offset within the trimmed span at a given clip time.
 * Forward playback reads the span front-to-back (`clipTime * rate`). Reverse
 * reads it back-to-front: at `clipTime = 0` it lands on the LAST sample of
 * the span, at `clipTime = clipDuration` it approaches the FIRST. This mirrors
 * the forward formula's own boundary shape (see the module comment on
 * `getEffectiveRateAt`), so a clip split at any point stays frame-continuous
 * across the cut (verified in retime/__tests__/reverse.test.ts).
 *
 * `clipDuration` is required to reverse - without it (older call sites that
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
	return sourceTime / getSafeRate({ rate: retime?.rate ?? 1 });
}

export function getEffectiveRateAt({
	retime,
}: {
	clipTime?: number;
	retime?: RetimeConfig;
}): number {
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
	return sourceSpan / getSafeRate({ rate: retime?.rate ?? 1 });
}
