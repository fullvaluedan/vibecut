import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type {
	AudioTrack,
	OverlayTrack,
	SceneTracks,
	VideoTrack,
} from "@/timeline";
import { cloneTrackForDuplicate } from "@/timeline/duplicate-track";
import { generateUUID } from "@/utils/id";

/**
 * Premiere-style "Duplicate track": clones a whole track — every clip with its
 * trims, animations, effects, masks, retime, params, name, plus the track's
 * mute/hidden flags — and drops the copy adjacent to the source (source index + 1
 * in the same region). A single atomic command; undo restores the pre-duplicate
 * snapshot in one step (mirrors `OverwriteDropCommand` / `RemoveRangesCommand`).
 *
 * Identity is the only thing that changes: the new track and every element get a
 * fresh `generateUUID()`, and linked-clip groups are re-keyed to a NEW shared
 * linkId so the copy's link groups are independent of the source's (the pure
 * `cloneTrackForDuplicate` helper owns that remap, so it stays bun-testable).
 *
 * `main` is the singular video track and is never duplicated into a second main:
 * a duplicate of `main` is inserted as a new overlay VIDEO track in the slot
 * immediately above `main` (the bottom of the overlay stack), which is adjacent
 * to it in the `[...overlay, main, ...audio]` visual order.
 */
export class DuplicateTrackCommand extends Command {
	private readonly sourceTrackId: string;
	private readonly newTrackId: string;
	private savedState: SceneTracks | null = null;

	constructor({ trackId }: { trackId: string }) {
		super();
		this.sourceTrackId = trackId;
		this.newTrackId = generateUUID();
	}

	getTrackId(): string {
		return this.newTrackId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		this.savedState = tracks;

		const overlayIndex = tracks.overlay.findIndex(
			(track) => track.id === this.sourceTrackId,
		);
		if (overlayIndex !== -1) {
			const clone = cloneTrackForDuplicate({
				track: tracks.overlay[overlayIndex],
				newTrackId: this.newTrackId,
			});
			editor.timeline.updateTracks(
				insertOverlay({ tracks, clone, atIndex: overlayIndex + 1 }),
			);
			return undefined;
		}

		const audioIndex = tracks.audio.findIndex(
			(track) => track.id === this.sourceTrackId,
		);
		if (audioIndex !== -1) {
			const clone = cloneTrackForDuplicate({
				track: tracks.audio[audioIndex],
				newTrackId: this.newTrackId,
			});
			editor.timeline.updateTracks(
				insertAudio({ tracks, clone, atIndex: audioIndex + 1 }),
			);
			return undefined;
		}

		if (tracks.main.id === this.sourceTrackId) {
			// `main` is singular — duplicate it as a new overlay video track in the
			// slot adjacent to (just above) main: the end of the overlay stack.
			const clone = cloneTrackForDuplicate({
				track: tracks.main,
				newTrackId: this.newTrackId,
			});
			editor.timeline.updateTracks(
				insertOverlay({ tracks, clone, atIndex: tracks.overlay.length }),
			);
			return undefined;
		}

		// No such track — nothing to do; leave the snapshot null so undo is a no-op.
		this.savedState = null;
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}

function insertOverlay({
	tracks,
	clone,
	atIndex,
}: {
	tracks: SceneTracks;
	clone: OverlayTrack | VideoTrack;
	atIndex: number;
}): SceneTracks {
	const index = Math.min(Math.max(atIndex, 0), tracks.overlay.length);
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, index),
			clone,
			...tracks.overlay.slice(index),
		],
	};
}

function insertAudio({
	tracks,
	clone,
	atIndex,
}: {
	tracks: SceneTracks;
	clone: AudioTrack;
	atIndex: number;
}): SceneTracks {
	const index = Math.min(Math.max(atIndex, 0), tracks.audio.length);
	return {
		...tracks,
		audio: [
			...tracks.audio.slice(0, index),
			clone,
			...tracks.audio.slice(index),
		],
	};
}
