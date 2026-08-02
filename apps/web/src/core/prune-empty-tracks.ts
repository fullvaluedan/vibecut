import type { SceneTracks } from "@/timeline";

/**
 * The empty-implicit-track pruning rule (T15.4): drop an overlay/audio track
 * once its last element is removed, UNLESS it was explicitly user-created
 * (`keepWhenEmpty`), which persists like a Premiere track until the user
 * deletes it. `main` (V1) is never a candidate - it isn't stored in either
 * array. Pulled out of `EditorCore`'s command reactor (core/index.ts) so the
 * rule is bun-testable without a full editor instance.
 */
export function pruneEmptyImplicitTracks(tracks: SceneTracks): SceneTracks {
	return {
		...tracks,
		overlay: tracks.overlay.filter(
			(track) => track.elements.length > 0 || track.keepWhenEmpty,
		),
		audio: tracks.audio.filter(
			(track) => track.elements.length > 0 || track.keepWhenEmpty,
		),
	};
}
