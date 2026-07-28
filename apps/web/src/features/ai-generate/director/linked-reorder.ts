import type { SceneTracks, TimelineElement } from "@/timeline";
import type { PlannedElementMove } from "@/timeline/group-move";
import { findLinkedPartners } from "@/timeline/link-elements";
import { addMediaTime, subMediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * Expand planned same-track reorder moves to LINKED partners: each moved
 * clip's linked partners (a video's separated audio) shift by the SAME delta
 * on their own tracks, inside the same MoveElementCommand, so a pre-cut
 * chronological reorder can no longer bake in an A/V desync. This is what
 * lets run-director drop its old conservative skip-if-linked guard.
 *
 * A partner that already has its own planned move is never moved twice.
 * FrameCut-owned module.
 */
export function expandMovesToLinkedPartners({
	tracks,
	moves,
}: {
	tracks: SceneTracks;
	moves: PlannedElementMove[];
}): PlannedElementMove[] {
	if (moves.length === 0) return moves;

	const elementsById = new Map<string, TimelineElement>();
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const element of track.elements) {
			elementsById.set(element.id, element);
		}
	}

	const movedIds = new Set(moves.map((move) => move.elementId));
	const partnerMoves: PlannedElementMove[] = [];
	for (const move of moves) {
		const element = elementsById.get(move.elementId);
		if (!element) continue;
		const delta = subMediaTime({
			a: move.newStartTime,
			b: element.startTime,
		});
		if (delta === ZERO_MEDIA_TIME) continue;

		const partners = findLinkedPartners({
			ref: { trackId: move.sourceTrackId, elementId: move.elementId },
			tracks,
			mode: "timeline",
		});
		for (const partnerRef of partners) {
			if (movedIds.has(partnerRef.elementId)) continue;
			const partner = elementsById.get(partnerRef.elementId);
			if (!partner) continue;
			movedIds.add(partnerRef.elementId);
			partnerMoves.push({
				sourceTrackId: partnerRef.trackId,
				targetTrackId: partnerRef.trackId,
				elementId: partnerRef.elementId,
				newStartTime: addMediaTime({ a: partner.startTime, b: delta }),
			});
		}
	}

	return [...moves, ...partnerMoves];
}
