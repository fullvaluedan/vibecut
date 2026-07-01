import type { TimelineElement } from "@/timeline";
import { addMediaTime, type MediaTime } from "@/wasm";

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
