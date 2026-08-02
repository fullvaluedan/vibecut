import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { MAX_AUDIO_TRACKS } from "@/timeline/placement/track-cap";

let currentTracks: SceneTracks;
const mediaAssets = [{ id: "m1", hasAudio: true }];
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ tracks: currentTracks }) },
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = tracks;
				},
			},
			media: { getAssets: () => mediaAssets },
		}),
	},
}));

import { ToggleSourceAudioSeparationCommand } from "@/commands/timeline/element/toggle-source-audio-separation";

function video(id: string): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "m1",
		isSourceAudioEnabled: true,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function busyAudioTrack(id: string) {
	return {
		...buildEmptyTrack({ id, type: "audio" }),
		elements: [
			{
				id: `${id}-clip`,
				type: "audio" as const,
				name: `${id}-clip`,
				startTime: mediaTime({ ticks: 0 }),
				duration: mediaTime({ ticks: 100 }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				params: { volume: 1, muted: false },
				sourceType: "upload" as const,
				mediaId: "other",
			},
		],
	};
}

describe("ToggleSourceAudioSeparationCommand at the audio cap", () => {
	test("never fails at MAX_AUDIO_TRACKS: reuses the least-occupied lane instead of throwing", () => {
		const main: VideoTrack = {
			id: "main",
			type: "video",
			name: "V1",
			muted: false,
			hidden: false,
			elements: [video("v1")],
		};
		// 8 audio lanes, all busy at [0,100) except a5 which is empty.
		const audio = Array.from({ length: MAX_AUDIO_TRACKS }, (_, i) =>
			i === 4 ? buildEmptyTrack({ id: "a5", type: "audio" }) : busyAudioTrack(`a${i + 1}`),
		);
		currentTracks = { overlay: [], main, audio };

		expect(() => {
			const command = new ToggleSourceAudioSeparationCommand({
				trackId: "main",
				elementId: "v1",
			});
			command.execute();
		}).not.toThrow();

		// No 9th audio track was minted.
		expect(currentTracks.audio.length).toBe(MAX_AUDIO_TRACKS);
		// The separated audio landed on the least-occupied (empty) lane.
		const target = currentTracks.audio.find((t) => t.id === "a5");
		expect(target?.elements.some((e) => e.id !== "a5-clip")).toBe(true);
		// The video is marked separated and linked to its new audio partner.
		const separatedVideo = currentTracks.main.elements.find(
			(el) => el.id === "v1",
		) as VideoElement;
		expect(separatedVideo.isSourceAudioEnabled).toBe(false);
		expect(separatedVideo.linkId).toBeTruthy();
	});
});
