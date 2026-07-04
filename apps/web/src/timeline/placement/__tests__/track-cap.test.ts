import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import {
	MAX_VIDEO_TRACKS,
	isAtVideoTrackCap,
	lastVideoTrackId,
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
