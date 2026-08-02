import { describe, expect, mock, test } from "bun:test";
import type { AudioElement, AudioTrack, SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// Same EditorCore stand-in pattern as add-track.test.ts: TracksSnapshotCommand
// only calls `timeline.updateTracks`, so that's all the stub needs.
let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = tracks;
				},
			},
		}),
	},
}));

import { TracksSnapshotCommand } from "@/commands/timeline/tracks-snapshot";

function buildAudioElement({ fadeInSec }: { fadeInSec: number }): AudioElement {
	return {
		id: "a1",
		type: "audio",
		name: "a1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 1_000_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { volume: 0, muted: false, fadeInSec },
		sourceType: "upload",
		mediaId: "m1",
	};
}

describe("TracksSnapshotCommand - fade drag round-trip (T18.3)", () => {
	// This is the exact undo mechanism the fade handles and the Audio tab's
	// numeric fields both use: one previewElements()/commitPreview() drag or
	// edit produces exactly ONE TracksSnapshotCommand.
	test("execute applies the dragged fade, undo restores the previous value", () => {
		const trackBefore: AudioTrack = {
			...buildEmptyTrack({ id: "a-track", type: "audio" }),
			elements: [buildAudioElement({ fadeInSec: 0 })],
		};
		const before: SceneTracks = {
			overlay: [],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [trackBefore],
		};

		const trackAfter: AudioTrack = {
			...trackBefore,
			elements: [buildAudioElement({ fadeInSec: 1.5 })],
		};
		const after: SceneTracks = { ...before, audio: [trackAfter] };

		currentTracks = before;
		const command = new TracksSnapshotCommand({ before, after });

		command.execute();
		expect(currentTracks.audio[0]?.elements[0]?.params.fadeInSec).toBe(1.5);

		command.undo();
		expect(currentTracks.audio[0]?.elements[0]?.params.fadeInSec).toBe(0);
	});
});
