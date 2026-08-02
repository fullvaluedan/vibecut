import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	TextTrack,
	VideoTrack,
} from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import {
	buildTimelineSnapshot,
	buildTrackLabels,
	findSnapshotClip,
	findSnapshotTrack,
	linkedSnapshotClips,
	type AssistantSnapshotEditor,
} from "../snapshot";
import {
	collectAssistantContext,
	readAssistantTranscript,
	type AssistantTranscriptSource,
} from "../collect";
import { FPS, sec } from "./fixtures";

function videoElement({
	id,
	startSec,
	durationSec,
	name,
	mediaId,
	linkId,
}: {
	id: string;
	startSec: number;
	durationSec: number;
	name: string;
	mediaId: string;
	linkId?: string;
}) {
	return {
		id,
		type: "video" as const,
		name,
		mediaId,
		startTime: sec(startSec),
		duration: sec(durationSec),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: sec(durationSec),
		...(linkId ? { linkId } : {}),
		params: {},
	};
}

function scene(): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "Main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [
			// Deliberately out of order: the snapshot must sort them.
			videoElement({
				id: "b",
				startSec: 6,
				durationSec: 4,
				name: "second",
				mediaId: "media-2",
			}),
			videoElement({
				id: "a",
				startSec: 0,
				durationSec: 6,
				name: "first",
				mediaId: "media-1",
				linkId: "pair",
			}),
		],
	};
	const overlayVideo: VideoTrack = {
		id: "v2",
		name: "Video 2",
		type: "video",
		muted: false,
		hidden: false,
		elements: [],
	};
	const overlayText: TextTrack = {
		id: "t1",
		name: "Text",
		type: "text",
		hidden: false,
		elements: [
			{
				id: "title",
				type: "text",
				name: "Title",
				startTime: sec(1),
				duration: sec(2),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				motionTemplate: {
					templateId: "kinetic-title",
					groupId: "g1",
					variables: {},
				},
				params: {},
			},
		],
	};
	const audio: AudioTrack = {
		id: "a1",
		name: "Audio",
		type: "audio",
		muted: false,
		elements: [
			{
				id: "a-audio",
				type: "audio",
				sourceType: "upload",
				mediaId: "media-1",
				name: "first audio",
				startTime: ZERO_MEDIA_TIME,
				duration: sec(6),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				sourceDuration: sec(6),
				linkId: "pair",
				retime: { rate: 1.5, maintainPitch: true },
				params: {},
			},
		],
	};
	// Overlay order is top-down, so V2 sits above the text lane in the stack.
	return { overlay: [overlayVideo, overlayText], main, audio: [audio] };
}

function fakeEditor(): AssistantSnapshotEditor {
	const tracks = scene();
	return {
		project: {
			getActive: () => ({
				metadata: { id: "p1", name: "Fake project" },
				settings: { fps: FPS, canvasSize: { width: 1080, height: 1920 } },
			}),
		},
		scenes: {
			getActiveScene: () => ({
				tracks,
				bookmarks: [
					{ time: sec(8), note: "later" },
					{ time: sec(2), note: "earlier" },
				],
			}),
		},
		playback: { getCurrentTime: () => sec(3) },
		selection: {
			getSelectedElements: () => [{ trackId: "main", elementId: "a" }],
		},
		timeline: { getTotalDuration: () => sec(10) },
		media: {
			getAssets: () => [
				{ id: "media-1", name: "first.mp4" },
				{ id: "media-2", name: "second.mp4" },
			],
		},
	};
}

describe("buildTrackLabels", () => {
	test("main is V1, overlay video counts up, audio counts down", () => {
		const labels = buildTrackLabels(scene());
		expect(labels.get("main")).toBe("V1");
		expect(labels.get("t1")).toBe("T1");
		expect(labels.get("v2")).toBe("V2");
		expect(labels.get("a1")).toBe("A1");
	});
});

describe("buildTimelineSnapshot", () => {
	const snapshot = buildTimelineSnapshot({
		editor: fakeEditor(),
		toggles: {
			magnetEnabled: false,
			rippleEditingEnabled: true,
			snappingEnabled: false,
		},
	});

	test("reads the project header and the toggles the caller supplied", () => {
		expect(snapshot.projectId).toBe("p1");
		expect(snapshot.projectName).toBe("Fake project");
		expect(snapshot.canvas).toEqual({ width: 1080, height: 1920 });
		expect(snapshot.magnetEnabled).toBe(false);
		expect(snapshot.rippleEditingEnabled).toBe(true);
		expect(snapshot.snappingEnabled).toBe(false);
		expect(snapshot.playhead).toBe(sec(3));
		expect(snapshot.totalDuration).toBe(sec(10));
		expect(snapshot.selection).toEqual([{ trackId: "main", elementId: "a" }]);
	});

	test("orders tracks V1, overlay video, other overlays, then audio", () => {
		expect(snapshot.tracks.map((track) => track.label)).toEqual([
			"V1",
			"V2",
			"T1",
			"A1",
		]);
		expect(snapshot.tracks[0].isMain).toBe(true);
	});

	test("sorts clips by start time and resolves media names", () => {
		expect(snapshot.tracks[0].clips.map((clip) => clip.id)).toEqual(["a", "b"]);
		expect(snapshot.tracks[0].clips[0].mediaName).toBe("first.mp4");
	});

	test("carries link ids, retime, templates and the source-required flag", () => {
		const audio = snapshot.tracks[3].clips[0];
		expect(audio.linkId).toBe("pair");
		expect(audio.speed).toBe(1.5);
		expect(audio.maintainPitch).toBe(true);
		expect(audio.sourceDurationRequired).toBe(true);
		const title = snapshot.tracks[2].clips[0];
		expect(title.templateId).toBe("kinetic-title");
		expect(title.sourceDurationRequired).toBe(false);
	});

	test("markers are sorted by time", () => {
		expect(snapshot.markers.map((marker) => marker.note)).toEqual([
			"earlier",
			"later",
		]);
	});

	test("defaults the magnet on and the transcript to none", () => {
		const plain = buildTimelineSnapshot({ editor: fakeEditor() });
		expect(plain.magnetEnabled).toBe(true);
		expect(plain.transcript).toEqual({ source: "none", words: [] });
		expect(plain.protectedSpans).toEqual([]);
	});

	test("lookups find clips, tracks by id or label, and linked partners", () => {
		expect(findSnapshotClip(snapshot, "title")?.name).toBe("Title");
		expect(findSnapshotClip(snapshot, "nope")).toBeNull();
		expect(findSnapshotTrack(snapshot, "A1")?.id).toBe("a1");
		expect(findSnapshotTrack(snapshot, "a1")?.label).toBe("A1");
		expect(findSnapshotTrack(snapshot, "V9")).toBeNull();
		const first = findSnapshotClip(snapshot, "a");
		expect(first).not.toBeNull();
		if (first) {
			expect(linkedSnapshotClips(snapshot, first).map((clip) => clip.id)).toEqual([
				"a-audio",
			]);
		}
	});
});

describe("readAssistantTranscript", () => {
	const words = [{ start: 1, end: 1.5, text: "hello" }];

	function source(
		overrides: Partial<AssistantTranscriptSource>,
	): AssistantTranscriptSource {
		return {
			readLineageWords: () => null,
			readCachedWords: () => [],
			...overrides,
		};
	}

	test("prefers an explained lineage", () => {
		const result = readAssistantTranscript(
			source({
				readLineageWords: () => ({ status: "explained", words }),
				readCachedWords: () => [{ start: 9, end: 9.5, text: "stale" }],
			}),
		);
		expect(result.source).toBe("lineage");
		expect(result.words).toEqual([{ startSec: 1, endSec: 1.5, text: "hello" }]);
	});

	test("falls back to the cache when the lineage cannot explain the timeline", () => {
		const result = readAssistantTranscript(
			source({
				readLineageWords: () => ({ status: "cannot-explain", words: [] }),
				readCachedWords: () => words,
			}),
		);
		expect(result.source).toBe("cache");
		expect(result.words).toHaveLength(1);
	});

	test("reports none when neither path has words", () => {
		expect(readAssistantTranscript(source({})).source).toBe("none");
	});

	test("a throwing read path degrades to the next one instead of failing", () => {
		const result = readAssistantTranscript(
			source({
				readLineageWords: () => {
					throw new Error("storage exploded");
				},
				readCachedWords: () => words,
			}),
		);
		expect(result.source).toBe("cache");
	});

	test("a throwing cache read still yields a usable empty transcript", () => {
		const result = readAssistantTranscript(
			source({
				readCachedWords: () => {
					throw new Error("storage exploded");
				},
			}),
		);
		expect(result).toEqual({ source: "none", words: [] });
	});
});

describe("collectAssistantContext", () => {
	test("returns both the snapshot and the serialized context", () => {
		const { snapshot, context } = collectAssistantContext({
			editor: fakeEditor(),
			transcriptSource: {
				readLineageWords: () => ({
					status: "explained",
					words: [{ start: 3, end: 3.4, text: "here" }],
				}),
				readCachedWords: () => [],
			},
			toggles: {
				magnetEnabled: true,
				rippleEditingEnabled: false,
				snappingEnabled: true,
			},
		});
		expect(snapshot.transcript.source).toBe("lineage");
		expect(context.project.aspect).toBe("9:16");
		expect(context.transcript?.text).toBe("here");
		expect(context.tracks.map((track) => track.label)).toEqual([
			"V1",
			"V2",
			"T1",
			"A1",
		]);
	});
});

describe("media time helper sanity", () => {
	test("the fixtures build frame-aligned times", () => {
		expect(sec(1)).toBe(mediaTimeFromSeconds({ seconds: 1 }));
	});
});
