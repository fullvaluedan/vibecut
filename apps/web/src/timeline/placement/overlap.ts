import type { TimelineElement } from "@/timeline";
import type { PlacementTimeSpan } from "./types";

interface TrackWithElements {
	elements: TimelineElement[];
}

function wouldElementOverlap({
	elements,
	startTime,
	endTime,
	excludeElementId,
	excludeElementIds,
}: {
	elements: TimelineElement[];
	startTime: number;
	endTime: number;
	excludeElementId?: string;
	excludeElementIds?: ReadonlySet<string>;
}): boolean {
	return elements.some((element) => {
		if (excludeElementId && element.id === excludeElementId) {
			return false;
		}
		if (excludeElementIds?.has(element.id)) {
			return false;
		}

		const elementEnd = element.startTime + element.duration;
		return startTime < elementEnd && endTime > element.startTime;
	});
}

export function canPlaceTimeSpansOnTrack({
	track,
	timeSpans,
	excludeElementIds,
}: {
	track: TrackWithElements;
	timeSpans: PlacementTimeSpan[];
	// Every element in this set is skipped from the overlap test on this track.
	// A multi-clip move excludes its whole moving set, so shifted siblings that
	// still overlap their own old positions don't falsely collide (parity with
	// `canApplyMovesToExistingTracks` at commit time). The per-span
	// `excludeElementId` (the anchor) is kept for callers that pass only one.
	excludeElementIds?: ReadonlySet<string>;
}): boolean {
	return timeSpans.every(({ startTime, duration, excludeElementId }) => {
		return !wouldElementOverlap({
			elements: track.elements,
			startTime,
			endTime: startTime + duration,
			excludeElementId,
			excludeElementIds,
		});
	});
}
