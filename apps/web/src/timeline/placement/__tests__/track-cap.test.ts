import { describe, expect, test } from "bun:test";
import type { AudioElement, SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import {
	MAX_AUDIO_TRACKS,
	MAX_VIDEO_TRACKS,
	audioTrackCount,
	isAtAudioTrackCap,
	isAtVideoTrackCap,
	lastVideoTrackId,
	leastOccupiedAudioTrackId,
	remainingAudioTrackBudget,
	remainingVideoTrackBudget,
	videoTrackCount,
} from "@/timeline/placement/track-cap";

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

describe("track-cap", () => {
	test("counts main as the one always-present video track", () => {
		expect(videoTrackCount(buildTracks())).toBe(1);
	});

	test("counts overlay video tracks, ignores other overlay types", () => {
		const tracks = buildTracks({
			overlay: [
				buildEmptyTrack({ id: "v2", type: "video" }),
				buildEmptyTrack({ id: "t1", type: "text" }),
				buildEmptyTrack({ id: "g1", type: "graphic" }),
				buildEmptyTrack({ id: "v3", type: "video" }),
			],
		});
		// main + v2 + v3 = 3
		expect(videoTrackCount(tracks)).toBe(3);
	});

	test("audio tracks never count toward the video cap", () => {
		const tracks = buildTracks({
			audio: [
				buildEmptyTrack({ id: "a1", type: "audio" }),
				buildEmptyTrack({ id: "a2", type: "audio" }),
			],
		});
		expect(videoTrackCount(tracks)).toBe(1);
		expect(isAtVideoTrackCap(tracks)).toBe(false);
	});

	test("isAtVideoTrackCap flips exactly at MAX_VIDEO_TRACKS", () => {
		const overlaySeven = Array.from({ length: MAX_VIDEO_TRACKS - 1 }, (_, i) =>
			buildEmptyTrack({ id: `v${i + 2}`, type: "video" }),
		);
		const atCap = buildTracks({ overlay: overlaySeven });
		expect(videoTrackCount(atCap)).toBe(MAX_VIDEO_TRACKS);
		expect(isAtVideoTrackCap(atCap)).toBe(true);
		expect(remainingVideoTrackBudget(atCap)).toBe(0);

		const belowCap = buildTracks({ overlay: overlaySeven.slice(1) });
		expect(isAtVideoTrackCap(belowCap)).toBe(false);
		expect(remainingVideoTrackBudget(belowCap)).toBe(1);
	});

	test("lastVideoTrackId is the topmost overlay video track, else main", () => {
		expect(lastVideoTrackId(buildTracks())).toBe("main");
		const tracks = buildTracks({
			overlay: [
				buildEmptyTrack({ id: "t1", type: "text" }),
				buildEmptyTrack({ id: "v2", type: "video" }),
			],
		});
		// first overlay video track wins (topmost video lane)
		expect(lastVideoTrackId(tracks)).toBe("v2");
	});
});

function audioElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { volume: 1, muted: false },
		sourceType: "upload",
		mediaId: `media-${id}`,
	};
}

function audioTrackWith(id: string, elements: AudioElement[]) {
	return { ...buildEmptyTrack({ id, type: "audio" }), elements };
}

describe("audio track cap", () => {
	test("isAtAudioTrackCap flips exactly at MAX_AUDIO_TRACKS", () => {
		const eight = Array.from({ length: MAX_AUDIO_TRACKS }, (_, i) =>
			buildEmptyTrack({ id: `a${i + 1}`, type: "audio" }),
		);
		const atCap: SceneTracks = { overlay: [], main: buildEmptyTrack({ id: "main", type: "video" }), audio: eight };
		expect(audioTrackCount(atCap)).toBe(MAX_AUDIO_TRACKS);
		expect(isAtAudioTrackCap(atCap)).toBe(true);
		expect(remainingAudioTrackBudget(atCap)).toBe(0);

		const belowCap: SceneTracks = { ...atCap, audio: eight.slice(1) };
		expect(isAtAudioTrackCap(belowCap)).toBe(false);
		expect(remainingAudioTrackBudget(belowCap)).toBe(1);
	});

	test("video tracks never count toward the audio cap", () => {
		const tracks: SceneTracks = {
			overlay: [
				buildEmptyTrack({ id: "v2", type: "video" }),
				buildEmptyTrack({ id: "v3", type: "video" }),
			],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [],
		};
		expect(audioTrackCount(tracks)).toBe(0);
		expect(isAtAudioTrackCap(tracks)).toBe(false);
	});

	test("leastOccupiedAudioTrackId picks the lane with the fewest elements overlapping the span", () => {
		const tracks: SceneTracks = {
			overlay: [],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [
				audioTrackWith("a1", [audioElement({ id: "e1", startTime: 0, duration: 100 })]),
				audioTrackWith("a2", []),
				audioTrackWith("a3", [
					audioElement({ id: "e2", startTime: 0, duration: 50 }),
					audioElement({ id: "e3", startTime: 200, duration: 50 }),
				]),
			],
		};
		// a2 is empty (0 overlaps) for any span.
		expect(
			leastOccupiedAudioTrackId({ tracks, span: { startTime: 0, duration: 100 } }),
		).toBe("a2");
	});

	test("leastOccupiedAudioTrackId ties break to the lowest index (A1 before A2)", () => {
		const tracks: SceneTracks = {
			overlay: [],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [audioTrackWith("a1", []), audioTrackWith("a2", []), audioTrackWith("a3", [])],
		};
		// All three lanes are equally (un)occupied - lowest index wins.
		expect(
			leastOccupiedAudioTrackId({ tracks, span: { startTime: 0, duration: 100 } }),
		).toBe("a1");
	});

	test("leastOccupiedAudioTrackId counts only elements that OVERLAP the span, not total occupancy", () => {
		const tracks: SceneTracks = {
			overlay: [],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [
				// a1 has one element, but it doesn't overlap the query span at all.
				audioTrackWith("a1", [audioElement({ id: "e1", startTime: 0, duration: 50 })]),
				// a2 has one element that DOES overlap the query span.
				audioTrackWith("a2", [audioElement({ id: "e2", startTime: 900, duration: 50 })]),
			],
		};
		expect(
			leastOccupiedAudioTrackId({ tracks, span: { startTime: 1000, duration: 100 } }),
		).toBe("a1");
	});
});
