import type { FrameRate } from "opencut-wasm";
import {
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import {
	addMediaTime,
	clampMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	minMediaTime,
	roundFrameTicks,
	roundMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import type {
	ComputeLinkedResizeArgs,
	ComputeResizeArgs,
	GroupResizeMember,
	GroupResizeResult,
	GroupResizeUpdate,
	ResizeSide,
} from "./types";

/** One frame's `MediaTime` duration at the given project fps. Shared by
 * `computeLinkedResize` (the min-duration floor/ceiling) and by
 * `clamp-reason.ts` (which needs the identical value to classify a clamp the
 * same way this file computes it). */
export function getMinDurationForFps(fps: FrameRate): MediaTime {
	return mediaTime({
		ticks: Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator),
	});
}

/**
 * The floor for a left-side drag whose positional bounds have been lifted
 * (magnet pins the start) on an element with no source limit at all - an image
 * or a text clip, which can grow forever. An hour of ticks is far beyond any
 * real drag, so it reads as "unbounded" without needing a nullable minimum.
 */
const UNBOUNDED_LEFT_DELTA = mediaTime({ ticks: -3600 * TICKS_PER_SECOND });

/**
 * Resize a SINGLE clip (the grabbed one), clamped solely by that clip's own
 * source extent and its neighbor bounds. An adjacent clip constrains the drag
 * only as a `leftNeighborBound` / `rightNeighborBound`, never as a co-resized
 * member. Arbitrary multi-select group fan-out stays removed by decision
 * (U2 / OQ2); the only multi-member path is `computeLinkedResize`, scoped
 * strictly to LINKED partners (a video and its separated audio).
 */
export function computeResize({
	member,
	side,
	deltaTime,
	fps,
}: ComputeResizeArgs): GroupResizeResult {
	return computeLinkedResize({ members: [member], side, deltaTime, fps });
}

/**
 * Resize a linked set (the grabbed clip plus its linked partners) as ONE
 * gesture: a single shared timeline delta, clamped by the MOST restrictive
 * member (max of per-member minimums, min of per-member maximums, including
 * each member's own source headroom and neighbor bounds; the caller builds
 * members so the whole set is excluded from neighbor bounds). The delta is
 * snapped to a frame exactly once, then ONE update per member is derived from
 * it; source-side deltas are computed PER MEMBER inside `buildResizeUpdate`
 * (a retimed partner consumes `delta * rate` of source, never the shared
 * timeline delta). Scope is strictly linked partners; this is NOT the removed
 * multi-select group-resize (U2 / OQ2).
 */
export function computeLinkedResize({
	members,
	side,
	deltaTime,
	fps,
	rippleTrim,
}: ComputeLinkedResizeArgs): GroupResizeResult {
	const minDuration = getMinDurationForFps(fps);
	const membersMinimumDeltaTime = members.reduce<MediaTime>(
		(minimum, member) =>
			maxMediaTime({
				a: minimum,
				b: getMinimumAllowedDeltaTime({ member, side, minDuration }),
			}),
		getMinimumAllowedDeltaTime({ member: members[0], side, minDuration }),
	);
	// Ripple shrink floor: a right-handle shrink with ripple ON shifts
	// downstream clips left on every track, so the cross-track headroom the
	// caller measured also bounds the delta (a shifted clip must never land on
	// a clip that straddles the pivot and stays put).
	const minimumDeltaTime =
		side === "right" && rippleTrim?.shrinkFloorDelta != null
			? maxMediaTime({
					a: membersMinimumDeltaTime,
					b: rippleTrim.shrinkFloorDelta,
				})
			: membersMinimumDeltaTime;
	const membersMaximumDeltaTime = members.reduce<MediaTime | null>(
		(maximum, member) => {
			const memberMaximum = getMaximumAllowedDeltaTime({
				member,
				side,
				minDuration,
			});
			if (memberMaximum === null) return maximum;
			if (maximum === null) return memberMaximum;
			return minMediaTime({ a: maximum, b: memberMaximum });
		},
		null,
	);
	// Magnet shrink ceiling: a LEFT-handle magnet trim pins the member's start,
	// so the gap it closes downstream is driven by a POSITIVE delta. Same
	// straddler headroom as the right-handle floor above, just the other sign.
	const magnetCeiling =
		side === "left" ? (rippleTrim?.shrinkCeilingDelta ?? null) : null;
	const maximumDeltaTime =
		magnetCeiling === null
			? membersMaximumDeltaTime
			: membersMaximumDeltaTime === null
				? magnetCeiling
				: minMediaTime({ a: membersMaximumDeltaTime, b: magnetCeiling });

	const clampedDeltaTime =
		maximumDeltaTime === null
			? maxMediaTime({ a: minimumDeltaTime, b: deltaTime })
			: clampMediaTime({
					time: deltaTime,
					min: minimumDeltaTime,
					max: maximumDeltaTime,
				});

	// Snap the drag delta to a frame exactly once, then derive every patch
	// field from that single snapped value. This keeps the invariant
	// `trimStart + duration*rate + trimEnd == sourceDuration` exact: the same
	// delta is added on one side of the element and removed from the other,
	// so the rounding cancels by construction. Per-field rounding (the old
	// approach) couldn't preserve this because the individual rounds don't
	// compose when `sourceDuration` isn't frame-aligned.
	const snappedDeltaTime = mediaTime({
		ticks: roundFrameTicks({ ticks: clampedDeltaTime, fps }),
	});
	// Re-clamp after rounding. Bounds derived from other elements are
	// frame-aligned, so this is normally a no-op; at the source-extent limit
	// the bound may not be frame-aligned, and honouring the bound takes
	// precedence over frame alignment (you can't extend past real content).
	const finalDeltaTime =
		maximumDeltaTime === null
			? maxMediaTime({ a: minimumDeltaTime, b: snappedDeltaTime })
			: clampMediaTime({
					time: snappedDeltaTime,
					min: minimumDeltaTime,
					max: maximumDeltaTime,
				});

	return {
		deltaTime: Object.is(finalDeltaTime, -0) ? ZERO_MEDIA_TIME : finalDeltaTime,
		updates: members.map((member) =>
			buildResizeUpdate({
				member,
				side,
				deltaTime: finalDeltaTime,
			}),
		),
	};
}

/**
 * T18.2 (T18.1 follow-up): which trim field a timeline-side resize consumes.
 * Forward playback reads the trimmed span front-to-back, so trimming the
 * timeline HEAD (`side: "left"`) advances into the source from its own head
 * (`trimStart` grows) and trimming the timeline TAIL (`side: "right"`) chops
 * from the source's own tail (`trimEnd` grows) - the pre-T18.2 behavior,
 * unchanged for every non-reversed clip.
 *
 * A REVERSED clip reads the span back-to-front (see retime/resolve.ts): its
 * timeline HEAD (clipTime 0) samples the LAST instant of the visible span,
 * and its timeline TAIL samples the FIRST. So trimming the timeline head of
 * a reversed clip removes frames that were reading near the source's TAIL -
 * `trimEnd` should grow, not `trimStart` - and trimming the timeline tail
 * removes frames reading near the source's HEAD, growing `trimStart`
 * instead. This is exactly the mirror `computeSplitTrimBoundaries` already
 * applies for a reversed split; this is the same swap for a resize/trim
 * drag (verified in group-resize/__tests__/compute-resize.test.ts "reversed
 * trim").
 */
function getReversedAwareTrimSide({
	member,
	side,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
}): "trimStart" | "trimEnd" {
	const reversed = member.retime?.reversed === true;
	if (reversed) {
		return side === "left" ? "trimEnd" : "trimStart";
	}
	return side === "left" ? "trimStart" : "trimEnd";
}

/**
 * The same head/tail swap as `getReversedAwareTrimSide`, expressed as the
 * two trim VALUES rather than a field name - `getResizeBoundBreakdown` needs
 * to plug the right one into its span arithmetic for both the left and
 * right branch, not just decide which field a patch writes to.
 */
function getReversedAwareTrimFields({
	member,
}: {
	member: GroupResizeMember;
}): { headField: MediaTime; tailField: MediaTime } {
	const reversed = member.retime?.reversed === true;
	return reversed
		? { headField: member.trimEnd, tailField: member.trimStart }
		: { headField: member.trimStart, tailField: member.trimEnd };
}

function buildResizeUpdate({
	member,
	side,
	deltaTime,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	deltaTime: MediaTime;
}): GroupResizeUpdate {
	const sourceDelta = getSourceDeltaForClipDelta({
		member,
		clipDelta: deltaTime,
	});
	const trimSide = getReversedAwareTrimSide({ member, side });

	if (side === "left") {
		const trimStart =
			trimSide === "trimStart"
				? maxMediaTime({
						a: ZERO_MEDIA_TIME,
						b: addMediaTime({ a: member.trimStart, b: sourceDelta }),
					})
				: member.trimStart;
		const trimEnd =
			trimSide === "trimEnd"
				? maxMediaTime({
						a: ZERO_MEDIA_TIME,
						b: addMediaTime({ a: member.trimEnd, b: sourceDelta }),
					})
				: member.trimEnd;
		return {
			trackId: member.trackId,
			elementId: member.elementId,
			patch: {
				trimStart,
				trimEnd,
				startTime: addMediaTime({ a: member.startTime, b: deltaTime }),
				duration: subMediaTime({ a: member.duration, b: deltaTime }),
			},
		};
	}

	const trimStart =
		trimSide === "trimStart"
			? maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({ a: member.trimStart, b: sourceDelta }),
				})
			: member.trimStart;
	const trimEnd =
		trimSide === "trimEnd"
			? maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({ a: member.trimEnd, b: sourceDelta }),
				})
			: member.trimEnd;
	return {
		trackId: member.trackId,
		elementId: member.elementId,
		patch: {
			trimStart,
			trimEnd,
			startTime: member.startTime,
			duration: addMediaTime({ a: member.duration, b: deltaTime }),
		},
	};
}

function getMinimumAllowedDeltaTime({
	member,
	side,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	minDuration: MediaTime;
}): MediaTime {
	return getResizeBoundBreakdown({ member, side, minDuration }).minimum;
}

function getMaximumAllowedDeltaTime({
	member,
	side,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	minDuration: MediaTime;
}): MediaTime | null {
	return getResizeBoundBreakdown({ member, side, minDuration }).maximum;
}

/** Why a bound is where it is: `clamp-reason.ts` reports this straight to the
 * UI, so the three values here ARE the three reasons CapCut-style feedback
 * distinguishes. */
export type ResizeBoundReason = "source-limit" | "neighbor" | "min-duration";

export interface ResizeBoundBreakdown {
	minimum: MediaTime;
	minimumReason: ResizeBoundReason;
	/** `null` = unbounded (no neighbor, and either no source limit applies -
	 * images/text - or the source limit doesn't cap this direction). */
	maximum: MediaTime | null;
	maximumReason: ResizeBoundReason | null;
}

/**
 * The single source of truth for a member's per-side resize bounds, split
 * into the value AND which constraint produced it. `getMinimumAllowedDeltaTime`
 * / `getMaximumAllowedDeltaTime` above are thin wrappers over this (so the
 * clamp math itself is defined exactly once); `clamp-reason.ts` calls this
 * directly to classify a drag that has run into a bound.
 *
 * `member.sourceDurationRequired` (VIDEO/AUDIO elements) distinguishes a real
 * "no more footage" limit from a data anomaly: a required sourceDuration that
 * is missing (metadata not loaded yet) is treated as ZERO extra headroom
 * instead of unbounded, so playback never runs into non-existent source.
 * Images/text never set this flag, so a missing sourceDuration on them keeps
 * meaning "genuinely no source limit" (free extension), exactly as before.
 */
export function getResizeBoundBreakdown({
	member,
	side,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	minDuration: MediaTime;
}): ResizeBoundBreakdown {
	if (side === "right") {
		const minimum = subMediaTime({ a: minDuration, b: member.duration });
		const rightNeighborCeiling =
			member.rightNeighborBound === null
				? null
				: subMediaTime({
						a: member.rightNeighborBound,
						b: addMediaTime({ a: member.startTime, b: member.duration }),
					});

		if (member.sourceDuration == null && !member.sourceDurationRequired) {
			return {
				minimum,
				minimumReason: "min-duration",
				maximum: rightNeighborCeiling,
				maximumReason: rightNeighborCeiling === null ? null : "neighbor",
			};
		}

		const sourceDurationCeiling =
			member.sourceDuration == null
				? ZERO_MEDIA_TIME
				: subMediaTime({
						a: getDurationForVisibleSourceSpan({
							member,
							sourceSpan: subMediaTime({
								a: getSourceDuration({ member }),
								// T18.2 (T18.1 follow-up): the right handle grows the
								// TAIL field (see `getReversedAwareTrimFields`) - which is
								// unspent source once the HEAD field is subtracted from the
								// total. Non-reversed head field = trimStart (unchanged);
								// reversed head field = trimEnd.
								b: getReversedAwareTrimFields({ member }).headField,
							}),
						}),
						b: member.duration,
					});
		if (rightNeighborCeiling === null) {
			return {
				minimum,
				minimumReason: "min-duration",
				maximum: sourceDurationCeiling,
				maximumReason: "source-limit",
			};
		}
		return {
			minimum,
			minimumReason: "min-duration",
			maximum: minMediaTime({ a: rightNeighborCeiling, b: sourceDurationCeiling }),
			maximumReason:
				rightNeighborCeiling <= sourceDurationCeiling ? "neighbor" : "source-limit",
		};
	}

	// side === "left"
	const maximum = subMediaTime({ a: member.duration, b: minDuration });
	// `null` = no positional floor at all: the magnet pins this member's start,
	// so the left neighbor and the timeline-zero wall are both irrelevant and
	// only the source extent can stop the drag.
	const leftNeighborFloor = member.leftBoundLifted
		? null
		: member.leftNeighborBound !== null
			? subMediaTime({ a: member.leftNeighborBound, b: member.startTime })
			: subMediaTime({ a: ZERO_MEDIA_TIME, b: member.startTime });

	if (member.sourceDuration == null && !member.sourceDurationRequired) {
		return {
			minimum: leftNeighborFloor ?? UNBOUNDED_LEFT_DELTA,
			minimumReason: leftNeighborFloor === null ? "source-limit" : "neighbor",
			maximum,
			maximumReason: "min-duration",
		};
	}

	const maximumSourceExtension =
		member.sourceDuration == null
			? ZERO_MEDIA_TIME
			: subMediaTime({
					a: getDurationForVisibleSourceSpan({
						member,
						sourceSpan: addMediaTime({
							a: getVisibleSourceSpanForDuration({
								member,
								duration: member.duration,
							}),
							// T18.2 (T18.1 follow-up): the left handle grows the HEAD
							// field (see `getReversedAwareTrimFields`) - non-reversed
							// head field = trimStart (unchanged); reversed head field =
							// trimEnd.
							b: getReversedAwareTrimFields({ member }).headField,
						}),
					}),
					b: member.duration,
				});
	const sourceFloor = subMediaTime({ a: ZERO_MEDIA_TIME, b: maximumSourceExtension });
	if (leftNeighborFloor === null) {
		return {
			minimum: sourceFloor,
			minimumReason: "source-limit",
			maximum,
			maximumReason: "min-duration",
		};
	}
	return {
		minimum: maxMediaTime({ a: leftNeighborFloor, b: sourceFloor }),
		minimumReason: leftNeighborFloor >= sourceFloor ? "neighbor" : "source-limit",
		maximum,
		maximumReason: "min-duration",
	};
}

function getSourceDeltaForClipDelta({
	member,
	clipDelta,
}: {
	member: GroupResizeMember;
	clipDelta: MediaTime;
}): MediaTime {
	if (!member.retime) {
		return clipDelta;
	}

	const sourceDelta =
		clipDelta >= 0
			? getSourceSpanAtClipTime({
					clipTime: clipDelta,
					retime: member.retime,
				})
			: -getSourceSpanAtClipTime({
					clipTime: Math.abs(clipDelta),
					retime: member.retime,
				});
	return roundMediaTime({ time: sourceDelta });
}

function getVisibleSourceSpanForDuration({
	member,
	duration,
}: {
	member: GroupResizeMember;
	duration: MediaTime;
}): MediaTime {
	if (!member.retime) {
		return duration;
	}

	return roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: duration,
			retime: member.retime,
		}),
	});
}

function getDurationForVisibleSourceSpan({
	member,
	sourceSpan,
}: {
	member: GroupResizeMember;
	sourceSpan: MediaTime;
}): MediaTime {
	if (!member.retime) {
		return sourceSpan;
	}

	return roundMediaTime({
		time: getTimelineDurationForSourceSpan({
			sourceSpan,
			retime: member.retime,
		}),
	});
}

function getSourceDuration({ member }: { member: GroupResizeMember }): MediaTime {
	if (member.sourceDuration != null) {
		return member.sourceDuration;
	}

	return addMediaTime({
		a: addMediaTime({
			a: member.trimStart,
			b: getVisibleSourceSpanForDuration({
			member,
			duration: member.duration,
			}),
		}),
		b: member.trimEnd,
	});
}
