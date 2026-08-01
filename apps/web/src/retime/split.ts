import type { RetimeConfig } from "@/timeline";
import { addMediaTime, type MediaTime } from "@/wasm";
import { getSourceTimeAtClipTime } from "./resolve";

export function getSourceSpanAtClipTime({
	clipTime,
	retime,
}: {
	clipTime: number;
	retime?: RetimeConfig;
}): number {
	return Math.max(0, getSourceTimeAtClipTime({ clipTime, retime }));
}

/**
 * T18.1: which side of a split gets a NEW trim boundary vs. keeps the
 * original. Forward playback reads the trimmed span front-to-back, so the
 * left half (earlier on the timeline) keeps the source's head - it inherits
 * `trimStart` unchanged and gets a new `trimEnd` (chopping off what the
 * right half now owns). The right half is the mirror.
 *
 * Reverse plays the span back-to-front: the left half (earlier on the
 * timeline) is actually reading the source's TAIL first, so the roles flip -
 * left inherits `trimEnd` unchanged and gets a new `trimStart`; right
 * inherits `trimStart` unchanged and gets a new `trimEnd`. Skipping this
 * swap would splice in the wrong source frames right at the cut (verified in
 * retime/__tests__/reverse.test.ts "split keeps a reversed clip
 * frame-continuous").
 */
export function computeSplitTrimBoundaries({
	trimStart,
	trimEnd,
	leftSourceSpan,
	rightSourceSpan,
	retime,
}: {
	trimStart: MediaTime;
	trimEnd: MediaTime;
	leftSourceSpan: MediaTime;
	rightSourceSpan: MediaTime;
	retime?: RetimeConfig;
}): {
	leftTrimStart: MediaTime;
	leftTrimEnd: MediaTime;
	rightTrimStart: MediaTime;
	rightTrimEnd: MediaTime;
} {
	if (retime?.reversed === true) {
		return {
			leftTrimStart: addMediaTime({ a: trimStart, b: rightSourceSpan }),
			leftTrimEnd: trimEnd,
			rightTrimStart: trimStart,
			rightTrimEnd: addMediaTime({ a: trimEnd, b: leftSourceSpan }),
		};
	}
	return {
		leftTrimStart: trimStart,
		leftTrimEnd: addMediaTime({ a: trimEnd, b: rightSourceSpan }),
		rightTrimStart: addMediaTime({ a: trimStart, b: leftSourceSpan }),
		rightTrimEnd: trimEnd,
	};
}

export function splitRetimeAtClipTime({
	retime,
}: {
	retime?: RetimeConfig;
	splitClipTime: number;
}): {
	left: RetimeConfig | undefined;
	right: RetimeConfig | undefined;
} {
	return { left: retime, right: retime };
}

export function adjustRetimeForTrimChange({
	retime,
}: {
	retime?: RetimeConfig;
	clipTrimTime: number;
	side: "start" | "end";
}): RetimeConfig | undefined {
	return retime;
}
