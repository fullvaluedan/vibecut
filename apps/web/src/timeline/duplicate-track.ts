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
//     `linkId`. A link group can span MULTIPLE tracks (a video on a video track +
//     its separated audio on an audio track). Duplicating a single track only
//     captures the members that live on THAT track, so we re-key by intra-track
//     membership: a linkId carried by 2+ elements in this track is a complete
//     intra-track group and is PRESERVED but RE-KEYED (the copied members share a
//     NEW single linkId, distinct from the source's, so editing the copy's link
//     group never touches the original); a linkId carried by only ONE element in
//     this track has its partner on another track, so the clone DROPS that linkId
//     rather than producing a dangling group-of-one. Elements with no `linkId`
//     stay unlinked.
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
	// Count how many elements in THIS track carry each source linkId. A group
	// with 2+ members here is fully captured by the duplicate (an intra-track
	// link); a count of 1 means the group's partner lives on another track that
	// is not being duplicated, so the lone clone must be unlinked rather than
	// left dangling.
	const linkIdCounts = new Map<string, number>();
	for (const element of track.elements) {
		if (element.linkId !== undefined) {
			linkIdCounts.set(
				element.linkId,
				(linkIdCounts.get(element.linkId) ?? 0) + 1,
			);
		}
	}

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
		if (
			element.linkId !== undefined &&
			(linkIdCounts.get(element.linkId) ?? 0) >= 2
		) {
			// Complete intra-track group: preserve the link, re-keyed.
			next.linkId = remapLinkId(element.linkId);
		} else {
			// Unlinked, or the partner is on another (non-duplicated) track: drop
			// the link so the clone is cleanly unlinked, never a dangling group-of-one.
			next.linkId = undefined;
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
