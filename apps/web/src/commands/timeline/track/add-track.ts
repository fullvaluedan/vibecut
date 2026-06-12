import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TrackType } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import {
	buildEmptyTrack,
	getDefaultInsertIndexForTrack,
} from "@/timeline/placement";

export class AddTrackCommand extends Command {
	private trackId: string;
	private savedState: SceneTracks | null = null;

	constructor({
		type,
		index,
		keepWhenEmpty,
	}: {
		type: TrackType;
		index?: number;
		/** Premiere-style: the track persists even while empty. */
		keepWhenEmpty?: boolean;
	}) {
		super();
		this.type = type;
		this.index = index;
		this.keepWhenEmpty = keepWhenEmpty;
		this.trackId = generateUUID();
	}

	private type: TrackType;
	private index?: number;
	private keepWhenEmpty?: boolean;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const insertIndex =
			this.index ??
			getDefaultInsertIndexForTrack({
				tracks: this.savedState,
				trackType: this.type,
			});

		const updatedTracks =
			this.type === "audio"
				? buildAudioTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
						keepWhenEmpty: this.keepWhenEmpty,
					})
				: buildOverlayTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
						trackType: this.type,
						keepWhenEmpty: this.keepWhenEmpty,
					});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getTrackId(): string {
		return this.trackId;
	}
}

function buildAudioTrackState({
	tracks,
	insertIndex,
	trackId,
	keepWhenEmpty,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
	keepWhenEmpty?: boolean;
}): SceneTracks {
	const audioInsertIndex = Math.max(0, insertIndex - tracks.overlay.length - 1);
	const newTrack = {
		...buildEmptyTrack({ id: trackId, type: "audio" }),
		...(keepWhenEmpty ? { keepWhenEmpty } : {}),
	};
	return {
		...tracks,
		audio: [
			...tracks.audio.slice(0, audioInsertIndex),
			newTrack,
			...tracks.audio.slice(audioInsertIndex),
		],
	};
}

function buildOverlayTrackState({
	tracks,
	insertIndex,
	trackId,
	trackType,
	keepWhenEmpty,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
	trackType: Exclude<TrackType, "audio">;
	keepWhenEmpty?: boolean;
}): SceneTracks {
	const overlayInsertIndex = Math.min(insertIndex, tracks.overlay.length);
	const baseTrack =
		trackType === "video"
			? buildEmptyTrack({ id: trackId, type: "video" })
			: trackType === "text"
				? buildEmptyTrack({ id: trackId, type: "text" })
				: trackType === "graphic"
					? buildEmptyTrack({ id: trackId, type: "graphic" })
					: buildEmptyTrack({ id: trackId, type: "effect" });
	const newTrack = {
		...baseTrack,
		...(keepWhenEmpty ? { keepWhenEmpty } : {}),
	};
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, overlayInsertIndex),
			newTrack,
			...tracks.overlay.slice(overlayInsertIndex),
		],
	};
}
