/**
 * T19.3: the renderer half of a transition.
 *
 * `resolve.ts` gates a visual node on `clipTime in [0, duration)`. A transition
 * needs BOTH neighbours on screen at once, so during the transition window the
 * clip must be admitted OUTSIDE its own span - the left clip past its out
 * point, the right clip before its in point. These three helpers are the whole
 * change: an admission test, an opacity multiplier, and a source-time clamp.
 *
 * Everything is a pure function of the node params, so preview, export and the
 * fixture tests all read the same numbers.
 */

import { getSourceSpanAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline/types";
import type { TransitionRamp, TransitionRoles } from "@/timeline/transitions";

function rampFactor({
	ramp,
	time,
}: {
	ramp: TransitionRamp;
	time: number;
}): number {
	const span = ramp.endTicks - ramp.startTicks;
	if (span <= 0) return 1;
	if (time <= ramp.startTicks) {
		return ramp.direction === "out" ? 1 : 0;
	}
	if (time >= ramp.endTicks) {
		return ramp.direction === "in" ? 1 : 0;
	}

	const progress = (time - ramp.startTicks) / span;
	if (ramp.direction === "in") return progress;
	if (ramp.direction === "out") return 1 - progress;
	// "dip": 0 -> 1 at the midpoint -> 0.
	return 1 - Math.abs(2 * progress - 1);
}

function admits({
	ramp,
	timeOffset,
	duration,
	time,
	side,
}: {
	ramp: TransitionRamp;
	timeOffset: number;
	duration: number;
	time: number;
	side: "head" | "tail";
}): boolean {
	if (ramp.extendTicks <= 0) return false;
	if (side === "head") {
		// The clip renders BEFORE its own start, back to the window start.
		return time >= ramp.startTicks && time < timeOffset;
	}
	// The clip renders PAST its own end, out to the window end.
	return time >= timeOffset + duration && time < ramp.endTicks;
}

/**
 * The visibility gate. Returns the clip-local time (which may be negative, or
 * >= duration, inside a transition extension) or `null` when the node must not
 * render at all.
 */
export function resolveTransitionClipTime({
	timeOffset,
	duration,
	transitions,
	time,
}: {
	timeOffset: number;
	duration: number;
	transitions?: TransitionRoles;
	time: number;
}): number | null {
	const clipTime = time - timeOffset;
	if (clipTime >= 0 && clipTime < duration) {
		return clipTime;
	}
	if (!transitions) return null;

	if (
		transitions.head &&
		admits({
			ramp: transitions.head,
			timeOffset,
			duration,
			time,
			side: "head",
		})
	) {
		return clipTime;
	}
	if (
		transitions.tail &&
		admits({
			ramp: transitions.tail,
			timeOffset,
			duration,
			time,
			side: "tail",
		})
	) {
		return clipTime;
	}
	return null;
}

/** True when this time is only on screen because of a transition extension. */
export function isTransitionExtendedTime({
	timeOffset,
	duration,
	time,
}: {
	timeOffset: number;
	duration: number;
	time: number;
}): boolean {
	const clipTime = time - timeOffset;
	return clipTime < 0 || clipTime >= duration;
}

/**
 * The transition's contribution to a layer's alpha, as a MULTIPLIER. It is
 * multiplied onto whatever the user's own opacity (and opacity keyframes)
 * resolved to, so a transition never clobbers authored opacity - a clip held
 * at 50% dissolves between 50% and 0%, not between 100% and 0%.
 */
export function resolveTransitionOpacityFactor({
	transitions,
	time,
}: {
	transitions?: TransitionRoles;
	time: number;
}): number {
	if (!transitions) return 1;
	let factor = 1;
	if (transitions.head) {
		factor *= rampFactor({ ramp: transitions.head, time });
	}
	if (transitions.tail) {
		factor *= rampFactor({ ramp: transitions.tail, time });
	}
	return factor;
}

/**
 * EDGE HOLD. A crossDissolve samples past a clip's out point (or before its in
 * point) into trimmed-away source. When the clip was trimmed right to the end
 * of its file there is no such source, so the sample time is clamped back onto
 * the real source range and the boundary frame FREEZES for the rest of the
 * ramp - the standard NLE fallback, and the reason the model clamp does not
 * need to know about headroom at all.
 *
 * The real source range is `[0, trimStart + span(duration) + trimEnd]`, which
 * is exactly the file length the element was cut from.
 */
export function clampTransitionSourceTicks({
	ticks,
	trimStart,
	trimEnd,
	duration,
	retime,
}: {
	ticks: number;
	trimStart: number;
	trimEnd: number;
	duration: number;
	retime?: RetimeConfig;
}): number {
	const sourceEnd =
		trimStart + getSourceSpanAtClipTime({ clipTime: duration, retime }) + trimEnd;
	if (ticks < 0) return 0;
	if (ticks > sourceEnd) return sourceEnd;
	return ticks;
}
