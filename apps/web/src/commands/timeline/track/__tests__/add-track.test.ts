import { describe, expect, mock, test } from "bun:test";
import type { AudioTrack, SceneTracks, VideoTrack } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { mediaTime } from "@/wasm";

// A minimal EditorCore stand-in, matching the pattern used by
// ripple-shift-elements.test.ts: the command only reads the active scene's
// tracks (constructor AND execute) and writes the updated tracks back.
let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: {
				getActiveSceneOrNull: () => ({ tracks: currentTracks }),
				getActiveScene: () => ({ tracks: currentTracks }),
			},
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = tracks;
				},
			},
		}),
	},
}));

import { AddTrackCommand } from "@/commands/timeline/track/add-track";
import { MAX_AUDIO_TRACKS, MAX_VIDEO_TRACKS } from "@/timeline/placement/track-cap";

function videoTracks(count: number): VideoTrack[] {
	return Array.from({ length: count }, (_, i) =>
		buildEmptyTrack({ id: `v${i + 2}`, type: "video" }),
	);
}

function audioTracks(count: number): AudioTrack[] {
	return Array.from({ length: count }, (_, i) =>
		buildEmptyTrack({ id: `a${i + 1}`, type: "audio" }),
	);
}

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

describe("AddTrackCommand video cap", () => {
	test("below the cap: creates a real track and execute persists it", () => {
		currentTracks = buildTracks({ overlay: videoTracks(MAX_VIDEO_TRACKS - 2) });
		const command = new AddTrackCommand({ type: "video", keepWhenEmpty: true });
		const trackId = command.getTrackId();
		expect(currentTracks.overlay.some((t) => t.id === trackId)).toBe(false);

		command.execute();
		expect(currentTracks.overlay.some((t) => t.id === trackId)).toBe(true);
		expect(
			currentTracks.overlay.find((t) => t.id === trackId)?.keepWhenEmpty,
		).toBe(true);
	});

	test("at the cap: no-ops and reuses the topmost video lane", () => {
		currentTracks = buildTracks({ overlay: videoTracks(MAX_VIDEO_TRACKS - 1) });
		const before = currentTracks;
		const command = new AddTrackCommand({ type: "video" });

		// Reuses an EXISTING lane - no 9th track minted.
		expect(currentTracks.overlay.some((t) => t.id === command.getTrackId())).toBe(
			true,
		);

		command.execute();
		// execute() is a true no-op at the cap: no history entry, tracks untouched.
		expect(currentTracks).toBe(before);
		expect(currentTracks.overlay.length).toBe(MAX_VIDEO_TRACKS - 1);
	});
});

describe("AddTrackCommand audio cap", () => {
	test("below the cap: creates a real track", () => {
		currentTracks = buildTracks({ audio: audioTracks(MAX_AUDIO_TRACKS - 2) });
		const command = new AddTrackCommand({ type: "audio", keepWhenEmpty: true });
		const trackId = command.getTrackId();
		command.execute();
		expect(currentTracks.audio.some((t) => t.id === trackId)).toBe(true);
	});

	test("at the cap with a span: reuses the least-occupied lane and never throws", () => {
		const busy = buildEmptyTrack({ id: "a1", type: "audio" });
		busy.elements = [
			{
				id: "e1",
				type: "audio",
				name: "e1",
				startTime: mediaTime({ ticks: 0 }),
				duration: mediaTime({ ticks: 100 }),
				trimStart: mediaTime({ ticks: 0 }),
				trimEnd: mediaTime({ ticks: 0 }),
				params: { volume: 1, muted: false },
				sourceType: "upload",
				mediaId: "m1",
			},
		];
		const empty = buildEmptyTrack({ id: "a2", type: "audio" });
		currentTracks = buildTracks({
			audio: [busy, empty, ...audioTracks(MAX_AUDIO_TRACKS - 2).map((t, i) =>
				i === 0 ? { ...t, id: "a3" } : t,
			)],
		});
		expect(currentTracks.audio.length).toBe(MAX_AUDIO_TRACKS);

		const before = currentTracks;
		expect(() => {
			const command = new AddTrackCommand({
				type: "audio",
				span: { startTime: 0, duration: 100 },
			});
			// a2 is empty (0 overlaps) - the least-occupied lane for this span.
			expect(command.getTrackId()).toBe("a2");
			command.execute();
		}).not.toThrow();
		// True no-op: still exactly MAX_AUDIO_TRACKS lanes, nothing added.
		expect(currentTracks).toBe(before);
		expect(currentTracks.audio.length).toBe(MAX_AUDIO_TRACKS);
	});

	test("at the cap with no span: falls back to the first lane instead of throwing", () => {
		currentTracks = buildTracks({ audio: audioTracks(MAX_AUDIO_TRACKS) });
		expect(() => {
			const command = new AddTrackCommand({ type: "audio" });
			expect(command.getTrackId()).toBe("a1");
			command.execute();
		}).not.toThrow();
	});
});
