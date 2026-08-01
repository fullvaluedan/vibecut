/**
 * Deterministic timeline fixtures for the assistant serializer and validator
 * tests. Everything is frame-aligned at 30fps (one frame = 4000 ticks under the
 * test wasm shim) and nothing is random, so a serializer snapshot is stable.
 */

import type { FrameRate } from "opencut-wasm";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import type {
	SnapshotClip,
	SnapshotTrack,
	TimelineSnapshot,
} from "../snapshot";

export const FPS: FrameRate = { numerator: 30, denominator: 1 };

export function sec(seconds: number): MediaTime {
	return mediaTimeFromSeconds({ seconds });
}

export function videoClip({
	id,
	trackId,
	startSec,
	durationSec,
	name,
	mediaName,
	trimStartSec = 0,
	trimEndSec = 0,
	sourceDurationSec,
	linkId,
	speed,
}: {
	id: string;
	trackId: string;
	startSec: number;
	durationSec: number;
	name: string;
	mediaName?: string;
	trimStartSec?: number;
	trimEndSec?: number;
	sourceDurationSec?: number;
	linkId?: string;
	speed?: number;
}): SnapshotClip {
	return {
		id,
		trackId,
		type: "video",
		name,
		...(mediaName ? { mediaName } : {}),
		startTime: sec(startSec),
		duration: sec(durationSec),
		trimStart: sec(trimStartSec),
		trimEnd: sec(trimEndSec),
		...(sourceDurationSec !== undefined
			? { sourceDuration: sec(sourceDurationSec) }
			: {}),
		sourceDurationRequired: true,
		...(linkId ? { linkId } : {}),
		...(speed !== undefined ? { speed } : {}),
	};
}

export function textClip({
	id,
	trackId,
	startSec,
	durationSec,
	name,
	templateId,
}: {
	id: string;
	trackId: string;
	startSec: number;
	durationSec: number;
	name: string;
	templateId?: string;
}): SnapshotClip {
	return {
		id,
		trackId,
		type: "text",
		name,
		startTime: sec(startSec),
		duration: sec(durationSec),
		trimStart: sec(0),
		trimEnd: sec(0),
		sourceDurationRequired: false,
		...(templateId ? { templateId } : {}),
	};
}

export function audioClip({
	id,
	trackId,
	startSec,
	durationSec,
	name,
	linkId,
	sourceDurationSec,
	trimStartSec = 0,
	trimEndSec = 0,
}: {
	id: string;
	trackId: string;
	startSec: number;
	durationSec: number;
	name: string;
	linkId?: string;
	sourceDurationSec?: number;
	trimStartSec?: number;
	trimEndSec?: number;
}): SnapshotClip {
	return {
		id,
		trackId,
		type: "audio",
		name,
		startTime: sec(startSec),
		duration: sec(durationSec),
		trimStart: sec(trimStartSec),
		trimEnd: sec(trimEndSec),
		...(sourceDurationSec !== undefined
			? { sourceDuration: sec(sourceDurationSec) }
			: {}),
		sourceDurationRequired: true,
		...(linkId ? { linkId } : {}),
	};
}

function track({
	id,
	label,
	type,
	isMain = false,
	clips,
}: {
	id: string;
	label: string;
	type: SnapshotTrack["type"];
	isMain?: boolean;
	clips: SnapshotClip[];
}): SnapshotTrack {
	return { id, label, type, isMain, clips };
}

/**
 * A small, hand-checkable project: two main clips (the second trimmed on both
 * sides so it has real extension headroom), the first clip's separated audio,
 * one overlay title, one marker, a selection, and a short transcript.
 */
export function smallSnapshot(
	overrides: Partial<TimelineSnapshot> = {},
): TimelineSnapshot {
	const main = track({
		id: "track-main",
		label: "V1",
		type: "video",
		isMain: true,
		clips: [
			videoClip({
				id: "clip-intro",
				trackId: "track-main",
				startSec: 0,
				durationSec: 6,
				name: "intro",
				mediaName: "intro.mp4",
				sourceDurationSec: 6,
				linkId: "link-intro",
			}),
			videoClip({
				id: "clip-body",
				trackId: "track-main",
				startSec: 6,
				durationSec: 10,
				name: "body",
				mediaName: "body.mp4",
				trimStartSec: 2,
				trimEndSec: 4,
				sourceDurationSec: 16,
			}),
		],
	});
	const overlayText = track({
		id: "track-text",
		label: "T1",
		type: "text",
		clips: [
			textClip({
				id: "clip-title",
				trackId: "track-text",
				startSec: 1,
				durationSec: 3,
				name: "Kinetic title",
				templateId: "kinetic-title",
			}),
		],
	});
	const audio = track({
		id: "track-audio",
		label: "A1",
		type: "audio",
		clips: [
			audioClip({
				id: "clip-intro-audio",
				trackId: "track-audio",
				startSec: 0,
				durationSec: 6,
				name: "intro audio",
				linkId: "link-intro",
				sourceDurationSec: 6,
			}),
		],
	});
	return {
		projectId: "project-1",
		projectName: "Demo project",
		fps: FPS,
		canvas: { width: 1920, height: 1080 },
		totalDuration: sec(16),
		playhead: sec(7),
		selection: [{ trackId: "track-main", elementId: "clip-body" }],
		magnetEnabled: true,
		rippleEditingEnabled: false,
		snappingEnabled: true,
		tracks: [main, overlayText, audio],
		markers: [{ atTime: sec(5), note: "hook lands" }],
		transcript: {
			source: "lineage",
			words: [
				{ startSec: 0.5, endSec: 1, text: "hello" },
				{ startSec: 1, endSec: 1.4, text: "and" },
				{ startSec: 1.4, endSec: 2, text: "welcome" },
				{ startSec: 6.5, endSec: 7, text: "here" },
				{ startSec: 7, endSec: 7.5, text: "is" },
				{ startSec: 7.5, endSec: 8.2, text: "everything" },
			],
		},
		protectedSpans: [],
		...overrides,
	};
}

/**
 * A 30-minute synthetic project with 100 main-track clips (18s each), a full
 * second video lane, an audio lane, 60 markers and a 30-minute word-level
 * transcript. This is the size case the serializer's budget exists for.
 */
export function largeSnapshot(): TimelineSnapshot {
	const mainClips: SnapshotClip[] = [];
	for (let index = 0; index < 100; index += 1) {
		mainClips.push(
			videoClip({
				id: `main-${String(index).padStart(3, "0")}`,
				trackId: "track-main",
				startSec: index * 18,
				durationSec: 18,
				name: `take ${index + 1}`,
				mediaName: `interview-part-${index + 1}.mp4`,
				trimStartSec: 1,
				trimEndSec: 2,
				sourceDurationSec: 21,
			}),
		);
	}
	const overlayClips: SnapshotClip[] = [];
	for (let index = 0; index < 24; index += 1) {
		overlayClips.push(
			videoClip({
				id: `broll-${String(index).padStart(3, "0")}`,
				trackId: "track-broll",
				startSec: index * 75,
				durationSec: 8,
				name: `b-roll ${index + 1}`,
				mediaName: `broll-${index + 1}.mp4`,
				sourceDurationSec: 8,
			}),
		);
	}
	const audioClips: SnapshotClip[] = [];
	for (let index = 0; index < 12; index += 1) {
		audioClips.push(
			audioClip({
				id: `music-${String(index).padStart(3, "0")}`,
				trackId: "track-music",
				startSec: index * 150,
				durationSec: 120,
				name: `bed ${index + 1}`,
				sourceDurationSec: 120,
			}),
		);
	}
	const words = [];
	for (let index = 0; index < 5400; index += 1) {
		words.push({
			startSec: index * 0.33,
			endSec: index * 0.33 + 0.3,
			text: `word${index % 50}`,
		});
	}
	return {
		projectId: "project-long",
		projectName: "Thirty minute interview",
		fps: FPS,
		canvas: { width: 1920, height: 1080 },
		totalDuration: sec(1800),
		playhead: sec(900),
		selection: [{ trackId: "track-main", elementId: "main-050" }],
		magnetEnabled: true,
		rippleEditingEnabled: false,
		snappingEnabled: true,
		tracks: [
			track({
				id: "track-main",
				label: "V1",
				type: "video",
				isMain: true,
				clips: mainClips,
			}),
			track({
				id: "track-broll",
				label: "V2",
				type: "video",
				clips: overlayClips,
			}),
			track({
				id: "track-music",
				label: "A1",
				type: "audio",
				clips: audioClips,
			}),
		],
		markers: Array.from({ length: 60 }, (_, index) => ({
			atTime: sec(index * 30),
			note: `chapter ${index + 1}`,
		})),
		transcript: { source: "lineage", words },
		protectedSpans: [],
	};
}
