import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { pruneEmptyImplicitTracks } from "@/core/prune-empty-tracks";

describe("pruneEmptyImplicitTracks (T15.4 keepWhenEmpty)", () => {
	test("drops an implicitly-created empty track", () => {
		const tracks: SceneTracks = {
			overlay: [buildEmptyTrack({ id: "v2", type: "video" })], // no elements
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [],
		};
		const result = pruneEmptyImplicitTracks(tracks);
		expect(result.overlay).toEqual([]);
	});

	test("a user-added track (keepWhenEmpty) survives even with zero elements", () => {
		const userTrack = { ...buildEmptyTrack({ id: "v2", type: "video" }), keepWhenEmpty: true };
		const tracks: SceneTracks = {
			overlay: [userTrack],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [{ ...buildEmptyTrack({ id: "a1", type: "audio" }), keepWhenEmpty: true }],
		};
		const result = pruneEmptyImplicitTracks(tracks);
		expect(result.overlay.map((t) => t.id)).toEqual(["v2"]);
		expect(result.audio.map((t) => t.id)).toEqual(["a1"]);
	});

	test("a keepWhenEmpty track that later holds a clip is kept for the ordinary reason too", () => {
		const withClip = {
			...buildEmptyTrack({ id: "a1", type: "audio" }),
			keepWhenEmpty: true,
			elements: [
				{
					id: "c1",
					type: "audio" as const,
					name: "c1",
					startTime: 0 as never,
					duration: 100 as never,
					trimStart: 0 as never,
					trimEnd: 0 as never,
					params: { volume: 1, muted: false },
					sourceType: "upload" as const,
					mediaId: "m1",
				},
			],
		};
		const tracks: SceneTracks = {
			overlay: [],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [withClip],
		};
		const result = pruneEmptyImplicitTracks(tracks);
		expect(result.audio.map((t) => t.id)).toEqual(["a1"]);
	});

	test("mixed: implicit empty tracks are dropped, user-added and non-empty tracks survive", () => {
		const tracks: SceneTracks = {
			overlay: [
				buildEmptyTrack({ id: "implicit-empty", type: "video" }),
				{ ...buildEmptyTrack({ id: "user-empty", type: "text" }), keepWhenEmpty: true },
			],
			main: buildEmptyTrack({ id: "main", type: "video" }),
			audio: [buildEmptyTrack({ id: "implicit-empty-audio", type: "audio" })],
		};
		const result = pruneEmptyImplicitTracks(tracks);
		expect(result.overlay.map((t) => t.id)).toEqual(["user-empty"]);
		expect(result.audio).toEqual([]);
		// main is never touched by this rule.
		expect(result.main.id).toBe("main");
	});
});
