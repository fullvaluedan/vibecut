import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { mediaTime } from "@/wasm";

let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ tracks: currentTracks }) },
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = tracks;
				},
			},
		}),
	},
}));

import { RemoveTrackCommand } from "@/commands/timeline/track/remove-track";

function clip(id: string) {
	return {
		id,
		type: "audio" as const,
		name: id,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { volume: 1, muted: false },
		sourceType: "upload" as const,
		mediaId: `media-${id}`,
	};
}

describe("RemoveTrackCommand", () => {
	test("deletes the track and every element on it in ONE command, and undo restores both (order preserved)", () => {
		const a1 = { ...buildEmptyTrack({ id: "a1", type: "audio" }), elements: [clip("c1"), clip("c2")] };
		const a2 = buildEmptyTrack({ id: "a2", type: "audio" });
		const a3 = buildEmptyTrack({ id: "a3", type: "audio" });
		const original: SceneTracks = {
			overlay: [],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [a1, a2, a3],
		};
		currentTracks = original;

		const command = new RemoveTrackCommand("a2");
		command.execute();

		expect(currentTracks.audio.map((t) => t.id)).toEqual(["a1", "a3"]);
		// The held clips on the OTHER tracks are untouched.
		expect(currentTracks.audio[0].elements.map((e) => e.id)).toEqual(["c1", "c2"]);

		command.undo();
		expect(currentTracks).toBe(original);
		expect(currentTracks.audio.map((t) => t.id)).toEqual(["a1", "a2", "a3"]);
		expect(currentTracks.audio[0].elements.map((e) => e.id)).toEqual(["c1", "c2"]);
	});

	test("deleting a track that holds clips removes the clips too - one undo restores everything", () => {
		const trackWithClips = {
			...buildEmptyTrack({ id: "v2", type: "video" }),
			elements: [
				{
					id: "vc1",
					type: "video" as const,
					name: "vc1",
					startTime: mediaTime({ ticks: 0 }),
					duration: mediaTime({ ticks: 100 }),
					trimStart: mediaTime({ ticks: 0 }),
					trimEnd: mediaTime({ ticks: 0 }),
					mediaId: "m1",
					params: {
						"transform.positionX": 0,
						"transform.positionY": 0,
						"transform.scaleX": 1,
						"transform.scaleY": 1,
						"transform.rotate": 0,
						opacity: 1,
					},
				},
			],
		};
		const original: SceneTracks = {
			overlay: [trackWithClips],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [],
		};
		currentTracks = original;

		const command = new RemoveTrackCommand("v2");
		command.execute();
		expect(currentTracks.overlay).toEqual([]);

		command.undo();
		expect(currentTracks.overlay[0].elements.map((e) => e.id)).toEqual(["vc1"]);
	});

	test("main (V1) can never be deleted - structurally a no-op", () => {
		const original: SceneTracks = {
			overlay: [buildEmptyTrack({ id: "v2", type: "video" })],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [buildEmptyTrack({ id: "a1", type: "audio" })],
		};
		currentTracks = original;

		const command = new RemoveTrackCommand("main");
		command.execute();

		expect(currentTracks.main.id).toBe("main");
		expect(currentTracks.overlay.map((t) => t.id)).toEqual(["v2"]);
		expect(currentTracks.audio.map((t) => t.id)).toEqual(["a1"]);
	});
});
