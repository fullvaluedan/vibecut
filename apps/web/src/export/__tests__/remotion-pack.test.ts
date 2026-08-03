import { describe, expect, it } from "bun:test";
import {
	arrayBufferToBase64,
	buildRemotionPack,
	buildRemotionPackBundle,
	mediaExtension,
	mediaPackPath,
	slugifyMediaName,
	type RemotionPackInput,
	type RemotionStyleProfile,
} from "@/export/remotion-pack";
import type { SceneTracks } from "@/timeline/types";

/**
 * Fixture timeline (ticksPerSecond = 1000, so 4000 ticks = 4s): two main
 * clips (one trimmed, one retimed), one FrameCut AI overlay clip, one text
 * clip, one upload audio clip, one library audio clip, plus one unreferenced
 * media asset that must NOT be packed. Total content duration: 10s.
 */
const TICKS_PER_SECOND = 1000;

function fixtureTracks(): SceneTracks {
	return {
		main: {
			id: "track-main",
			name: "V1",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				{
					id: "clip-a",
					name: "interview.mp4",
					type: "video",
					mediaId: "m1",
					startTime: 0,
					duration: 4000,
					trimStart: 1000,
					trimEnd: 500,
					sourceDuration: 8000,
					params: {},
				},
				{
					id: "clip-b",
					name: "broll.webm",
					type: "video",
					mediaId: "m2",
					startTime: 4000,
					duration: 6000,
					trimStart: 0,
					trimEnd: 0,
					retime: { rate: 1.5 },
					params: {},
				},
			],
		},
		overlay: [
			{
				id: "track-overlay-video",
				name: "V2",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					{
						id: "clip-c",
						name: "overlay.webm",
						type: "video",
						mediaId: "m3",
						startTime: 1000,
						duration: 2000,
						trimStart: 0,
						trimEnd: 0,
						framecutAi: {
							compId: "authored:abc123",
							templateId: "kinetic-title",
							variables: {},
							groupId: "g1",
						},
						params: {},
					},
				],
			},
			{
				id: "track-text",
				name: "T1",
				type: "text",
				hidden: false,
				elements: [
					{
						id: "clip-d",
						name: "Title",
						type: "text",
						startTime: 1000,
						duration: 2000,
						trimStart: 0,
						trimEnd: 0,
						params: {},
					},
				],
			},
		],
		audio: [
			{
				id: "track-audio",
				name: "A1",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "clip-e",
						name: "music.mp3",
						type: "audio",
						sourceType: "upload",
						mediaId: "m4",
						startTime: 0,
						duration: 10000,
						trimStart: 0,
						trimEnd: 0,
						params: {},
					},
					{
						id: "clip-f",
						name: "Library loop",
						type: "audio",
						sourceType: "library",
						sourceUrl: "https://example.com/loop.mp3",
						startTime: 0,
						duration: 10000,
						trimStart: 0,
						trimEnd: 0,
						params: {},
					},
				],
			},
		],
	};
}

function fixtureInput(
	overrides: Partial<RemotionPackInput> = {},
): RemotionPackInput {
	return {
		project: {
			id: "p1",
			name: "Demo edit",
			fps: { numerator: 30, denominator: 1 },
			width: 1920,
			height: 1080,
		},
		tracks: fixtureTracks(),
		media: [
			{
				id: "m1",
				name: "interview.mp4",
				kind: "video",
				fileName: "interview.mp4",
				mimeType: "video/mp4",
				durationSec: 95.4,
				fps: 30,
				width: 1920,
				height: 1080,
				hasAudio: true,
			},
			{
				id: "m2",
				name: "broll.webm",
				kind: "video",
				fileName: "broll.webm",
				mimeType: "video/webm",
			},
			{
				id: "m3",
				name: "overlay.webm",
				kind: "video",
				fileName: "overlay.webm",
				mimeType: "video/webm",
				hasAlpha: true,
			},
			{
				id: "m4",
				name: "music.mp3",
				kind: "audio",
				fileName: "music.mp3",
				mimeType: "audio/mpeg",
			},
			{
				id: "m5",
				name: "unused.png",
				kind: "image",
				fileName: "unused.png",
				mimeType: "image/png",
			},
		],
		totalDurationSec: 10,
		ticksPerSecond: TICKS_PER_SECOND,
		transcript: {
			segments: [{ start: 0, end: 1.84, text: "Hello world" }],
			words: [
				{ start: 0, end: 0.32, text: "Hello" },
				{ start: 0.4, end: 1.84, text: "world" },
			],
		},
		generatedAt: "2026-08-03T14:00:00.000Z",
		...overrides,
	};
}

describe("buildRemotionPack EDL", () => {
	it("assigns track roles and orders main, overlays, audio", () => {
		const { edl } = buildRemotionPack(fixtureInput());
		expect(edl.tracks.map((track) => track.role)).toEqual([
			"main-video",
			"overlay-video",
			"overlay-text",
			"audio",
		]);
		expect(edl.format).toBe("framecut-edl");
		expect(edl.version).toBe(1);
		expect(edl.durationSec).toBe(10);
		expect(edl.fps).toEqual({ numerator: 30, denominator: 1 });
	});

	it("converts ticks to seconds and carries trims and retime", () => {
		const { edl } = buildRemotionPack(fixtureInput());
		const [clipA, clipB] = edl.tracks[0].clips;
		expect(clipA).toMatchObject({
			id: "clip-a",
			kind: "video",
			timelineStartSec: 0,
			durationSec: 4,
			mediaId: "m1",
			mediaPath: "media/m1-interview.mp4",
			trimStartSec: 1,
			trimEndSec: 0.5,
			sourceDurationSec: 8,
		});
		expect(clipA).not.toHaveProperty("retime");
		expect(clipB.retime).toEqual({ rate: 1.5 });
		expect(clipB.retime).not.toHaveProperty("reversed");
	});

	it("carries the framecutAi comp reference on generated overlay clips", () => {
		const { edl } = buildRemotionPack(fixtureInput());
		const clipC = edl.tracks[1].clips[0];
		expect(clipC.framecutAi).toEqual({
			compId: "authored:abc123",
			templateId: "kinetic-title",
			groupId: "g1",
		});
	});

	it("marks text clips media-free and library audio as a URL reference", () => {
		const { edl } = buildRemotionPack(fixtureInput());
		const clipD = edl.tracks[2].clips[0];
		expect(clipD.kind).toBe("text");
		expect(clipD).not.toHaveProperty("mediaId");
		const [clipE, clipF] = edl.tracks[3].clips;
		expect(clipE.mediaPath).toBe("media/m4-music.mp3");
		expect(clipF.sourceUrl).toBe("https://example.com/loop.mp3");
		expect(clipF).not.toHaveProperty("mediaId");
	});
});

describe("buildRemotionPack manifest", () => {
	it("packs only referenced media, with roles and generation flags", () => {
		const { manifest } = buildRemotionPack(fixtureInput());
		expect(manifest.media.map((entry) => entry.id).sort()).toEqual([
			"m1",
			"m2",
			"m3",
			"m4",
		]);
		const byId = new Map(manifest.media.map((entry) => [entry.id, entry]));
		expect(byId.get("m1")?.roles).toEqual(["main"]);
		expect(byId.get("m1")?.generated).toBe(false);
		expect(byId.get("m3")?.roles).toEqual(["overlay"]);
		expect(byId.get("m3")?.generated).toBe(true);
		expect(byId.get("m3")?.hasAlpha).toBe(true);
		expect(byId.get("m3")?.framecutAi?.compId).toBe("authored:abc123");
		expect(byId.get("m4")?.roles).toEqual(["audio"]);
	});

	it("lists deduplicated framecutAi comps with their clip ids", () => {
		const { manifest } = buildRemotionPack(fixtureInput());
		expect(manifest.framecutAi).toEqual([
			{
				compId: "authored:abc123",
				templateId: "kinetic-title",
				mediaId: "m3",
				clipIds: ["clip-c"],
			},
		]);
	});

	it("serializes styleProfile as null until T20.1 lands", () => {
		const { manifest } = buildRemotionPack(fixtureInput());
		expect(manifest.styleProfile).toBeNull();
	});

	it("passes a style profile through unchanged when one is provided", () => {
		const styleProfile: RemotionStyleProfile = {
			palette: { accent: "#38BDF8", supporting: ["#2567EC"] },
			fonts: { display: "Inter", body: "Inter" },
			motionStyle: "standard",
			density: "balanced",
		};
		const { manifest } = buildRemotionPack(fixtureInput({ styleProfile }));
		expect(manifest.styleProfile).toEqual(styleProfile);
	});

	it("points files.transcript at the transcript only when one is packed", () => {
		expect(
			buildRemotionPack(fixtureInput()).manifest.files.transcript,
		).toBe("transcript.json");
		const without = buildRemotionPack(fixtureInput({ transcript: null }));
		expect(without.manifest.files.transcript).toBeNull();
		expect(without.transcript).toBeNull();
	});

	it("summarizes tracks with clip counts and content extents", () => {
		const { manifest } = buildRemotionPack(fixtureInput());
		expect(manifest.tracks[0]).toMatchObject({
			role: "main-video",
			clipCount: 2,
			durationSec: 10,
		});
		expect(manifest.tracks[1]).toMatchObject({
			role: "overlay-video",
			clipCount: 1,
			durationSec: 3,
		});
	});
});

describe("round-trip invariants", () => {
	it("every EDL media reference resolves to a manifest entry and a pack file", () => {
		const pack = buildRemotionPack(fixtureInput());
		const mediaById = new Map(
			pack.manifest.media.map((entry) => [entry.id, entry]),
		);
		const filePaths = new Set(pack.mediaFiles.map((file) => file.path));
		for (const track of pack.edl.tracks) {
			for (const clip of track.clips) {
				if (!clip.mediaId) continue;
				const entry = mediaById.get(clip.mediaId);
				expect(entry).toBeDefined();
				expect(clip.mediaPath).toBe(entry?.path);
				expect(filePaths.has(entry?.path as string)).toBe(true);
			}
		}
	});

	it("main-track clip durations sum to the project duration", () => {
		const pack = buildRemotionPack(fixtureInput());
		const mainTrack = pack.edl.tracks.find(
			(track) => track.role === "main-video",
		);
		const sum = (mainTrack?.clips ?? []).reduce(
			(total, clip) => total + clip.durationSec,
			0,
		);
		expect(sum).toBe(pack.manifest.project.durationSec);
		expect(pack.manifest.tracks[0].durationSec).toBe(
			pack.manifest.project.durationSec,
		);
	});

	it("manifest, EDL and transcript survive a JSON round-trip unchanged", () => {
		const pack = buildRemotionPack(fixtureInput());
		for (const doc of [pack.manifest, pack.edl, pack.transcript]) {
			expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
		}
	});
});

describe("buildRemotionPackBundle", () => {
	it("bundles EDL, transcript and base64 media with directory-shape paths", () => {
		const pack = buildRemotionPack(fixtureInput());
		const mediaBytes = new TextEncoder().encode("fake media bytes");
		const mediaData = new Map<string, string>();
		for (const file of pack.mediaFiles) {
			mediaData.set(
				file.mediaId,
				arrayBufferToBase64({ buffer: mediaBytes.buffer as ArrayBuffer }),
			);
		}
		const bundle = buildRemotionPackBundle({ pack, mediaData });
		expect(bundle.format).toBe("framecut-remotion-pack-bundle");
		const paths = bundle.files.map((file) => file.path);
		expect(paths).toContain("edl.json");
		expect(paths).toContain("transcript.json");
		for (const file of pack.mediaFiles) {
			expect(paths).toContain(file.path);
		}
		// utf8 entries parse back to the original documents
		const edlFile = bundle.files.find((file) => file.path === "edl.json");
		expect(edlFile?.encoding).toBe("utf8");
		if (edlFile?.encoding === "utf8") {
			expect(JSON.parse(edlFile.text)).toEqual(pack.edl);
		}
		// base64 entries decode to the original bytes
		const mediaFile = bundle.files.find(
			(file) => file.path === pack.mediaFiles[0].path,
		);
		expect(mediaFile?.encoding).toBe("base64");
		if (mediaFile?.encoding === "base64") {
			const decoded = new TextDecoder().decode(
				Uint8Array.from(atob(mediaFile.data), (char) => char.charCodeAt(0)),
			);
			expect(decoded).toBe("fake media bytes");
		}
		// the whole bundle is JSON-safe
		expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
	});

	it("omits transcript.json when there is no transcript", () => {
		const pack = buildRemotionPack(fixtureInput({ transcript: null }));
		const bundle = buildRemotionPackBundle({ pack, mediaData: new Map() });
		expect(bundle.files.some((file) => file.path === "transcript.json")).toBe(
			false,
		);
	});
});

describe("media path helpers", () => {
	it("slugifies names and keeps extensions", () => {
		expect(slugifyMediaName({ name: "My Interview (take 2).MP4" })).toBe(
			"my-interview-take-2",
		);
		expect(slugifyMediaName({ name: "!!!" })).toBe("media");
		expect(
			mediaPackPath({
				media: {
					id: "m1",
					name: "My Interview (take 2).MP4",
					kind: "video",
					fileName: "My Interview (take 2).MP4",
				},
			}),
		).toBe("media/m1-my-interview-take-2.mp4");
	});

	it("falls back to the mime type for extensionless files", () => {
		expect(mediaExtension({ fileName: "clip", mimeType: "video/webm" })).toBe(
			"webm",
		);
		expect(mediaExtension({ fileName: "clip" })).toBe("bin");
	});
});
