import type { CreateTimelineElement, TimelineElement } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import { splitAnimationsAtTime } from "@/animation";
import { generateUUID } from "@/utils/id";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";

export interface RippleShift {
	id: string;
	startTime: MediaTime;
}

/**
 * Open a hole on a track for an insert. Mirror of `RemoveRangesCommand`'s
 * multi-track ripple-cut in the opposite direction: every element whose
 * `startTime >= insertStart` shifts RIGHT by `shiftDuration`, leaving a hole at
 * `insertStart` for the new clip.
 *
 * Pure and lossless: no element is trimmed or dropped, and a clip that merely
 * straddles the insert point is pushed by its whole start (`>=` boundary). The
 * controller turns these shifts into an `UpdateElementsCommand` applied BEFORE
 * the `InsertElementCommand` (open the hole first) so the insert never trips a
 * transient overlap or the main-track snap-to-0 rule.
 */
export function computeRippleInsertShifts({
	elements,
	insertStart,
	shiftDuration,
}: {
	elements: readonly TimelineElement[];
	insertStart: MediaTime;
	shiftDuration: MediaTime;
}): RippleShift[] {
	if (shiftDuration <= 0) {
		return [];
	}
	return elements
		.filter((element) => element.startTime >= insertStart)
		.map((element) => ({
			id: element.id,
			startTime: addMediaTime({ a: element.startTime, b: shiftDuration }),
		}));
}

/**
 * The clip on a lane that STRADDLES `insertStart`
 * (`startTime < insertStart < startTime + duration`), if any. A straddler is not
 * shifted by `computeRippleInsertShifts` (its start is before `insertStart`), so
 * an insert would land on top of it. The caller splits it so a gap-free hole
 * opens.
 */
export function findStraddlingElement({
	elements,
	insertStart,
}: {
	elements: readonly TimelineElement[];
	insertStart: MediaTime;
}): TimelineElement | null {
	return (
		elements.find(
			(element) =>
				element.startTime < insertStart &&
				insertStart < addMediaTime({ a: element.startTime, b: element.duration }),
		) ?? null
	);
}

export interface StraddleSplit {
	/** Shrink the original clip to `[start, insertStart]`. */
	headPatch: {
		id: string;
		duration: MediaTime;
		trimEnd: MediaTime;
		animations: TimelineElement["animations"];
	};
	/** Insert this new tail at `insertStart + shiftDuration`, source-aligned. */
	tail: CreateTimelineElement;
}

/**
 * Split a straddling clip at `insertStart` so a `shiftDuration`-wide hole opens
 * with no media lost: the head keeps `[start, insertStart]`, the tail moves to
 * `[insertStart + shiftDuration, ...]` with its source in-point advanced by the
 * head's source span (retime-aware, so a speed-ramped clip keeps the right cut).
 * Pure: returns the head shrink patch + the tail create-shape; the caller runs
 * them inside the same BatchCommand as the insert.
 *
 * The source-span / animation math mirrors `SplitElementsCommand` exactly (the
 * canonical split), so head and tail stay source-aligned by construction:
 *   - snap the TOTAL and HEAD source spans once each, derive the tail span as
 *     `total - head`; the head absorbs the TAIL's span into `trimEnd` and the
 *     tail advances `trimStart` by the HEAD's span, so
 *     `trimStart + duration*rate + trimEnd == sourceDuration` holds on both.
 *   - `splitAnimationsAtTime` partitions keyframes at the head's visible
 *     duration (head keeps the left side, tail the right, boundary keys added).
 *   - a linked straddler must NOT hand its `linkId` to the tail: that would
 *     falsely gang two audio clips to one unsplit video and corrupt A/V sync.
 *     The tail gets a FRESH `linkId` when the straddler carried one (splitting
 *     the linked video on its own track is out of v1 ripple scope).
 */
export function computeStraddleSplit({
	element,
	insertStart,
	shiftDuration,
}: {
	element: TimelineElement;
	insertStart: MediaTime;
	shiftDuration: MediaTime;
}): StraddleSplit {
	const retime = isRetimableElement(element) ? element.retime : undefined;
	const headVisibleDuration = subMediaTime({
		a: insertStart,
		b: element.startTime,
	});
	const tailVisibleDuration = subMediaTime({
		a: element.duration,
		b: headVisibleDuration,
	});
	// Snap the source-side split point once and derive the tail span from it so
	// `headSourceSpan + tailSourceSpan == totalSourceSpan` stays exact (same
	// discipline as SplitElementsCommand / compute-resize). The head keeps
	// `[start, insertStart]`, so it consumes the HEAD span and its `trimEnd` must
	// grow by the TAIL span (the source now cut off after the split), not the head
	// span — that was the source-misalignment bug.
	const headSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime: headVisibleDuration, retime }),
	});
	const totalSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime: element.duration, retime }),
	});
	const tailSourceSpan = subMediaTime({
		a: totalSourceSpan,
		b: headSourceSpan,
	});
	const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
		animations: element.animations,
		splitTime: headVisibleDuration,
		shouldIncludeSplitBoundary: true,
	});
	const { id: _id, animations: _animations, ...rest } = element;
	const tail: CreateTimelineElement = {
		...rest,
		startTime: addMediaTime({ a: insertStart, b: shiftDuration }),
		duration: tailVisibleDuration,
		trimStart: addMediaTime({ a: element.trimStart, b: headSourceSpan }),
		animations: rightAnimations,
		// A fresh linkId (or none): never share the straddler's gang with the tail.
		...(element.linkId !== undefined ? { linkId: generateUUID() } : {}),
	} as CreateTimelineElement;
	return {
		headPatch: {
			id: element.id,
			duration: headVisibleDuration,
			trimEnd: addMediaTime({ a: element.trimEnd, b: tailSourceSpan }),
			animations: leftAnimations,
		},
		tail,
	};
}
