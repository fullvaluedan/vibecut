import type { ElementType, SceneTracks } from "@/timeline";
import { getTrackTypeForElementType } from "./compatibility";
import { canPlaceTimeSpansOnTrack } from "./overlap";
import type { PlacementTimeSpan } from "./types";

/**
 * Premiere-parity drop policy (issue #4): a video/image drop prefers the main
 * track (V1) when the clip fits there at the drop time, instead of landing on
 * whatever overlay (V2+) lane the cursor happens to be over.
 *
 * Track order is `[...overlay, main, ...audio]`, so overlay (V2+) renders ABOVE
 * the main track (V1). Without this, a casual drop near the top of a project
 * that already has an overlay lands on V2 even when V1 is free.
 *
 * Takes (and returns) an index into that ordered track array. Deliberate
 * higher-track placement is still possible: when V1 is occupied at the drop
 * time this returns the hovered index unchanged (the placement resolver then
 * bumps the clip to an overlay/new track), and dropping above all tracks never
 * reaches this path. Non-video elements (graphic/text/effect/audio) are left
 * untouched.
 */
export function preferMainTrackIndex({
	tracks,
	elementType,
	hoveredTrackIndex,
	timeSpans,
}: {
	tracks: SceneTracks;
	elementType: ElementType;
	hoveredTrackIndex: number;
	timeSpans: PlacementTimeSpan[];
}): number {
	const trackType = getTrackTypeForElementType({ elementType });
	if (trackType !== "video") return hoveredTrackIndex;

	// Hovering the main track or an audio lane (at/after the main index) is a
	// deliberate target — only redirect when hovering an overlay lane above it.
	const mainIndex = tracks.overlay.length;
	if (hoveredTrackIndex >= mainIndex) return hoveredTrackIndex;

	const mainFits = canPlaceTimeSpansOnTrack({
		track: tracks.main,
		timeSpans,
	});
	return mainFits ? mainIndex : hoveredTrackIndex;
}
