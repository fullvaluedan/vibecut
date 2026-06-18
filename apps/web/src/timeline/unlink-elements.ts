import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline/types";
import { updateElementInSceneTracks } from "@/timeline/track-element-update";

function eachElement(
	tracks: SceneTracks,
): Array<{ trackId: string; element: TimelineElement }> {
	const out: Array<{ trackId: string; element: TimelineElement }> = [];
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const element of track.elements) {
			out.push({ trackId: track.id, element });
		}
	}
	return out;
}

/**
 * Dissolves the link group(s) the given refs belong to: clears `linkId` on
 * every element sharing a `linkId` with any ref, so the pieces select/move/trim
 * independently. Clearing the whole group (not just the refs) handles A/V pairs
 * and 3+ member groups; unrelated groups are untouched.
 *
 * Pure transform (no editor/wasm) so it is unit-testable. Returns the new tracks
 * plus the refs whose `linkId` was cleared. When nothing is linked it returns the
 * original tracks object unchanged (referentially equal), so callers/undo can
 * skip a no-op.
 */
export function unlinkElementsInSceneTracks({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): { tracks: SceneTracks; cleared: ElementRef[] } {
	const elements = eachElement(tracks);

	const targetLinkIds = new Set<string>();
	for (const ref of refs) {
		const linkId = elements.find(
			(entry) => entry.element.id === ref.elementId,
		)?.element.linkId;
		if (linkId) targetLinkIds.add(linkId);
	}

	if (targetLinkIds.size === 0) {
		return { tracks, cleared: [] };
	}

	let nextTracks = tracks;
	const cleared: ElementRef[] = [];
	for (const { trackId, element } of elements) {
		if (element.linkId && targetLinkIds.has(element.linkId)) {
			nextTracks = updateElementInSceneTracks({
				tracks: nextTracks,
				trackId,
				elementId: element.id,
				update: (el) => ({ ...el, linkId: undefined }) as TimelineElement,
			});
			cleared.push({ trackId, elementId: element.id });
		}
	}

	return { tracks: nextTracks, cleared };
}
