import type { SceneTracks } from "@/timeline";

/**
 * T15.4 track management: pure index math for the track-label-column
 * context menu's "Add video track" / "Add audio track" actions. Kept out of
 * `components/index.tsx` so it is bun-testable without React.
 *
 * `AddTrackCommand`'s `index` param is a single GLOBAL orderedTracks-style
 * index (`[...overlay, main, ...audio]`, see `commands/timeline/track/
 * add-track.ts`): for an overlay track (video/text/graphic/effect) it is
 * used directly as the overlay-array insert index; for an audio track it is
 * offset by `overlay.length + 1` before splicing into the audio array.
 */

/**
 * CapCut-style: "Add video track" inserts ABOVE the clicked lane when the
 * clicked track is itself a video overlay lane, else directly above main
 * (the bottom of the overlay stack - `tracks.overlay[0]` is topmost on
 * screen, so a higher array index sits lower, closer to main).
 */
export function computeAddVideoAboveIndex({
	tracks,
	clickedTrackId,
}: {
	tracks: SceneTracks;
	clickedTrackId?: string | null;
}): number {
	const clickedIndex = tracks.overlay.findIndex(
		(track) => track.id === clickedTrackId && track.type === "video",
	);
	return clickedIndex >= 0 ? clickedIndex : tracks.overlay.length;
}

/**
 * "Add audio track" inserts BELOW the clicked lane when the clicked track is
 * itself an audio lane, else below the last audio lane.
 */
export function computeAddAudioBelowIndex({
	tracks,
	clickedTrackId,
}: {
	tracks: SceneTracks;
	clickedTrackId?: string | null;
}): number {
	const clickedIndex = tracks.audio.findIndex(
		(track) => track.id === clickedTrackId,
	);
	const audioLocalIndex = clickedIndex >= 0 ? clickedIndex + 1 : tracks.audio.length;
	return tracks.overlay.length + 1 + audioLocalIndex;
}
