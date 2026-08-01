import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import {
	computeAddAudioBelowIndex,
	computeAddVideoAboveIndex,
} from "@/timeline/track-menu-actions";

function buildTracks({
	overlay = [],
	audio = [],
}: {
	overlay?: SceneTracks["overlay"];
	audio?: SceneTracks["audio"];
} = {}): SceneTracks {
	return {
		overlay,
		main: buildEmptyTrack({ id: "main", type: "video" }),
		audio,
	};
}

describe("computeAddVideoAboveIndex", () => {
	test("clicking a video lane inserts ABOVE it (same overlay index, pushing it down)", () => {
		const tracks = buildTracks({
			overlay: [
				buildEmptyTrack({ id: "v3", type: "video" }), // topmost
				buildEmptyTrack({ id: "t1", type: "text" }),
				buildEmptyTrack({ id: "v2", type: "video" }), // just above main
			],
		});
		expect(
			computeAddVideoAboveIndex({ tracks, clickedTrackId: "v2" }),
		).toBe(2);
		expect(
			computeAddVideoAboveIndex({ tracks, clickedTrackId: "v3" }),
		).toBe(0);
	});

	test("clicking a non-video lane (or main) inserts directly above main", () => {
		const tracks = buildTracks({
			overlay: [
				buildEmptyTrack({ id: "v2", type: "video" }),
				buildEmptyTrack({ id: "t1", type: "text" }),
			],
		});
		expect(
			computeAddVideoAboveIndex({ tracks, clickedTrackId: "t1" }),
		).toBe(tracks.overlay.length);
		expect(
			computeAddVideoAboveIndex({ tracks, clickedTrackId: "main" }),
		).toBe(tracks.overlay.length);
		expect(
			computeAddVideoAboveIndex({ tracks, clickedTrackId: null }),
		).toBe(tracks.overlay.length);
	});

	test("resolves to a real overlay-array index that AddTrackCommand can use directly", () => {
		const tracks = buildTracks({
			overlay: [buildEmptyTrack({ id: "v2", type: "video" })],
		});
		const index = computeAddVideoAboveIndex({ tracks, clickedTrackId: "v2" });
		expect(index).toBe(0);
	});
});

describe("computeAddAudioBelowIndex", () => {
	test("clicking an audio lane inserts BELOW it", () => {
		// global index formula: overlay.length + 1 + (localAudioIndex + 1)
		const tracks = buildTracks({
			overlay: [buildEmptyTrack({ id: "v2", type: "video" })],
			audio: [
				buildEmptyTrack({ id: "a1", type: "audio" }),
				buildEmptyTrack({ id: "a2", type: "audio" }),
			],
		});
		// Clicking a1 (local index 0) inserts at local index 1 -> global 1+1+1=3
		expect(computeAddAudioBelowIndex({ tracks, clickedTrackId: "a1" })).toBe(3);
		// Clicking a2 (local index 1) inserts at local index 2 -> global 1+1+2=4
		expect(computeAddAudioBelowIndex({ tracks, clickedTrackId: "a2" })).toBe(4);
	});

	test("clicking a non-audio lane inserts below the last audio lane", () => {
		const tracks = buildTracks({
			overlay: [buildEmptyTrack({ id: "v2", type: "video" })],
			audio: [
				buildEmptyTrack({ id: "a1", type: "audio" }),
				buildEmptyTrack({ id: "a2", type: "audio" }),
			],
		});
		// overlay.length(1) + 1 + audio.length(2) = 4, same as "below a2" above,
		// since a2 IS the last lane.
		expect(computeAddAudioBelowIndex({ tracks, clickedTrackId: "v2" })).toBe(4);
		expect(computeAddAudioBelowIndex({ tracks, clickedTrackId: null })).toBe(4);
	});

	test("no audio lanes yet: inserts right after main", () => {
		const tracks = buildTracks({ overlay: [] });
		expect(computeAddAudioBelowIndex({ tracks, clickedTrackId: null })).toBe(1);
	});
});
