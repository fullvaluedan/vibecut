import type { SceneTracks, TimelineElement, VideoTrack } from "@/timeline";
import { snapToHead } from "@/timeline/head-gravity";
import type { MediaTime } from "@/wasm";

export const MAIN_TRACK_NAME = "Main Track";

export function getEarliestMainTrackElement({
	mainTrack,
	excludeElementId,
}: {
	mainTrack: VideoTrack;
	excludeElementId?: string;
}): TimelineElement | null {
	const elements = mainTrack.elements.filter((element) => {
		return !excludeElementId || element.id !== excludeElementId;
	});
	if (elements.length === 0) {
		return null;
	}

	return elements.reduce((earliestElement, element) => {
		return element.startTime < earliestElement.startTime
			? element
			: earliestElement;
	});
}

export function enforceMainTrackStart({
	tracks,
	targetTrackId,
	requestedStartTime,
	excludeElementId,
}: {
	tracks: SceneTracks;
	targetTrackId: string;
	requestedStartTime: MediaTime;
	excludeElementId?: string;
}): MediaTime {
	if (tracks.main.id !== targetTrackId) {
		return requestedStartTime;
	}

	const earliestElement = getEarliestMainTrackElement({
		mainTrack: tracks.main,
		excludeElementId,
	});
	// HEAD GRAVITY (Dan's fork, 2026-07-17): the absolute snap-to-0 is replaced
	// by the shared 2s gravity zone. A head-bound placement (empty track, or a
	// request at/before the earliest clip) snaps to 0 only when it lands under
	// HEAD_GRAVITY_SEC; beyond that it lands where requested. First import keeps
	// its lands-at-0 semantics naturally: default placements request 0 (or near
	// it), which is inside the zone.
	if (!earliestElement || requestedStartTime <= earliestElement.startTime) {
		return snapToHead({ startTime: requestedStartTime });
	}

	return requestedStartTime;
}
