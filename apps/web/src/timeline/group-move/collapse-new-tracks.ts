import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import type { GroupMember, PlannedTrackCreation } from "./types";

/**
 * Decide the NEW tracks a group move should create, collapsed to ONE track per
 * distinct SOURCE track (members sharing a source track share the new lane) and
 * capped so no more than `videoBudget` new VIDEO tracks are made. Source tracks
 * that can't get a new video track (budget exhausted) are absent from the
 * returned map — their members stay on their current track.
 *
 * Pure (integer/string only, no `@/wasm`), so it is bun-testable in isolation —
 * the explosion fix (Track-Select-Forward of N clips → N tracks) lives here.
 */
export function planCollapsedNewTracks({
	sortedMembers,
	videoBudget,
	blockStartIndex,
	newTrackIds,
}: {
	// Only the source track id + element type are read, so accept the minimal
	// shape — keeps this leaf pure (no MediaTime / `@/wasm`) and easy to test.
	sortedMembers: ReadonlyArray<Pick<GroupMember, "trackId" | "elementType">>;
	videoBudget: number;
	blockStartIndex: number;
	newTrackIds: string[];
}): {
	createTracks: PlannedTrackCreation[];
	newTrackIdBySourceTrackId: Map<string, string>;
} {
	let remainingVideoBudget = videoBudget;
	const newTrackIdBySourceTrackId = new Map<string, string>();
	const createTracks: PlannedTrackCreation[] = [];
	let nextNewTrackIdIndex = 0;
	let nextInsertIndex = blockStartIndex;

	for (const member of sortedMembers) {
		if (newTrackIdBySourceTrackId.has(member.trackId)) {
			continue;
		}
		const trackType = getTrackTypeForElementType({
			elementType: member.elementType,
		});
		if (trackType === "video") {
			if (remainingVideoBudget <= 0) {
				continue; // cap reached — this source track's members keep their lane
			}
			remainingVideoBudget -= 1;
		}
		const id = newTrackIds[nextNewTrackIdIndex];
		nextNewTrackIdIndex += 1;
		newTrackIdBySourceTrackId.set(member.trackId, id);
		createTracks.push({ id, type: trackType, index: nextInsertIndex });
		nextInsertIndex += 1;
	}

	return { createTracks, newTrackIdBySourceTrackId };
}
