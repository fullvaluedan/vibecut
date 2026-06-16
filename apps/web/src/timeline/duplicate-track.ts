// Pure deep-copy transform behind the Duplicate Track command (U6).
//
// Cloning a track means cloning every element with a FRESH identity while
// preserving all of its content (animations, params, masks, retime, effects,
// trims, startTime, duration, name, hidden/mute flags live on the element/track,
// not here). The two identity fields that must change are:
//
//   - `id`: every element in the copy gets a brand-new `generateUUID()` so the
//     copy and the source never collide.
//   - `linkId`: linked clips (a video + its separated audio, etc.) share one
//     `linkId`. In the copy that grouping must be PRESERVED but RE-KEYED — the
//     copied pair must share a NEW single linkId, distinct from the source's, so
//     editing the copy's link group never touches the original. Elements with no
//     `linkId` stay unlinked.
//
// Deliberately wasm-free: it treats every other field — including the `MediaTime`
// trims/startTime/duration — as an opaque value to copy verbatim, never doing any
// time math. That keeps it unit-testable under bun without pulling in the
// opencut-wasm binary. The command (`commands/timeline/track/duplicate-track.ts`)
// owns the snapshot / region-insert / undo concerns; this helper is just the
// shape transform.

import type { TimelineElement, TimelineTrack } from "@/timeline";
import { generateUUID } from "@/utils/id";

/**
 * Clone a track for the Duplicate Track command: assigns the given `newTrackId`,
 * gives every element a new unique id, and re-keys linkId groups so the copy is a
 * self-contained, independently-editable duplicate of the source.
 */
export function cloneTrackForDuplicate<T extends TimelineTrack>({
	track,
	newTrackId,
}: {
	track: T;
	newTrackId: string;
}): T {
	// One new linkId per distinct source linkId, shared across the copy's members
	// of that group. Built lazily so unlinked elements never get an entry.
	const linkIdRemap = new Map<string, string>();

	const remapLinkId = (sourceLinkId: string): string => {
		const existing = linkIdRemap.get(sourceLinkId);
		if (existing) return existing;
		const fresh = generateUUID();
		linkIdRemap.set(sourceLinkId, fresh);
		return fresh;
	};

	const clonedElements = track.elements.map((element): TimelineElement => {
		const next: TimelineElement = {
			...element,
			id: generateUUID(),
		};
		if (element.linkId !== undefined) {
			next.linkId = remapLinkId(element.linkId);
		}
		return next;
	});

	// `track.elements` is a typed union per track kind (e.g. VideoTrack only holds
	// video/image elements); the clones preserve each element's `type`, so the
	// narrowed array shape is sound under the spread.
	return {
		...track,
		id: newTrackId,
		elements: clonedElements,
	} as T;
}
