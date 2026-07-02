import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	TimelineElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { computeAvSyncOffset } from "@/timeline/av-sync";
import { buildAvSyncMap } from "@/timeline/av-sync-map";

// 30fps => 1 frame = 120_000 / 30 = 4_000 ticks.
const FPS: FrameRate = { numerator: 30, denominator: 1 };
const FRAME = 4_000;

function vid({
	id,
	startTime,
	duration,
	trimStart = 0,
	mediaId,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	trimStart?: number;
	mediaId: string;
	linkId?: string;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: trimStart }),
		trimEnd: ZERO_MEDIA_TIME,
		mediaId,
		linkId,
		params: {},
	} as unknown as VideoElement;
}

function aud({
	id,
	startTime,
	duration,
	trimStart = 0,
	mediaId,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	trimStart?: number;
	mediaId: string;
	linkId?: string;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: trimStart }),
		trimEnd: ZERO_MEDIA_TIME,
		sourceType: "upload",
		mediaId,
		linkId,
		params: {},
	} as unknown as AudioElement;
}

function tracks({
	main,
	audio = [],
	overlay = [],
}: {
	main: (VideoElement | (TimelineElement & { type: "image" }))[];
	audio?: AudioElement[][];
	overlay?: VideoElement[][];
}): SceneTracks {
	const mainTrack: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		elements: main as VideoTrack["elements"],
		muted: false,
		hidden: false,
	} as unknown as VideoTrack;
	const audioTracks: AudioTrack[] = audio.map((els, i) => ({
		id: `audio-${i}`,
		type: "audio",
		name: `A${i + 1}`,
		elements: els,
		muted: false,
	})) as unknown as AudioTrack[];
	const overlayTracks: VideoTrack[] = overlay.map((els, i) => ({
		id: `overlay-${i}`,
		type: "video",
		name: `V${i + 2}`,
		elements: els,
		muted: false,
		hidden: false,
	})) as unknown as VideoTrack[];
	return { overlay: overlayTracks, main: mainTrack, audio: audioTracks };
}

/**
 * The map must agree with the per-clip scan for EVERY element (no behavior
 * change), walk both and compare entry by entry.
 */
function assertParity(scene: SceneTracks) {
	const map = buildAvSyncMap({ tracks: scene, fps: FPS });
	for (const track of [...scene.overlay, scene.main, ...scene.audio]) {
		for (const el of track.elements) {
			const scan = computeAvSyncOffset({ element: el, tracks: scene, fps: FPS });
			const mapped = map.get(el.id) ?? null;
			if (scan === null) {
				expect(mapped).toBeNull();
				continue;
			}
			expect(mapped).not.toBeNull();
			expect(mapped?.offsetFrames).toBe(scan.offsetFrames);
			expect(mapped?.partner).toEqual(scan.partner);
		}
	}
}

describe("buildAvSyncMap", () => {
	test("linked pair with a 108-frame drift yields the correct offsetFrames", () => {
		const scene = tracks({
			main: [vid({ id: "v", startTime: 0, duration: 40 * FRAME, mediaId: "m", linkId: "L" })],
			audio: [
				[aud({ id: "a", startTime: 108 * FRAME, duration: 40 * FRAME, mediaId: "m", linkId: "L" })],
			],
		});
		const map = buildAvSyncMap({ tracks: scene, fps: FPS });
		expect(map.get("v")?.offsetFrames).toBe(108);
		expect(map.get("v")?.partner).toEqual({ trackId: "audio-0", elementId: "a" });
		expect(map.get("a")?.offsetFrames).toBe(108);
		expect(map.get("a")?.partner).toEqual({ trackId: "main", elementId: "v" });
		assertParity(scene);
	});

	test("legacy pairing (no linkId, same mediaId, overlapping source) resolves identically", () => {
		const scene = tracks({
			main: [vid({ id: "v", startTime: 0, duration: 40 * FRAME, trimStart: 0, mediaId: "m" })],
			audio: [
				[aud({ id: "a", startTime: 60 * FRAME, duration: 40 * FRAME, trimStart: 20 * FRAME, mediaId: "m" })],
			],
		});
		const map = buildAvSyncMap({ tracks: scene, fps: FPS });
		const scan = computeAvSyncOffset({
			element: scene.main.elements[0],
			tracks: scene,
			fps: FPS,
		});
		expect(scan).not.toBeNull();
		expect(map.get("v")?.offsetFrames).toBe(scan?.offsetFrames);
		expect(map.get("v")?.partner).toEqual(scan?.partner);
		assertParity(scene);
	});

	test("an unlinked clip with no partner yields no entry", () => {
		const scene = tracks({
			main: [vid({ id: "v", startTime: 0, duration: 40 * FRAME, mediaId: "m" })],
			audio: [
				// Different mediaId => not a legacy partner.
				[aud({ id: "a", startTime: 0, duration: 40 * FRAME, mediaId: "other" })],
			],
		});
		const map = buildAvSyncMap({ tracks: scene, fps: FPS });
		expect(map.has("v")).toBe(false);
		expect(map.has("a")).toBe(false);
		assertParity(scene);
	});

	test("parity holds on a representative multi-clip shape", () => {
		const scene = tracks({
			overlay: [
				[vid({ id: "ov", startTime: 0, duration: 20 * FRAME, mediaId: "mov", linkId: "LOV" })],
			],
			main: [
				vid({ id: "v1", startTime: 0, duration: 40 * FRAME, mediaId: "m1", linkId: "L1" }),
				vid({ id: "v2", startTime: 40 * FRAME, duration: 40 * FRAME, trimStart: 0, mediaId: "m2" }),
				vid({ id: "v3", startTime: 80 * FRAME, duration: 40 * FRAME, mediaId: "m3" }),
			],
			audio: [
				[
					aud({ id: "a1", startTime: 12 * FRAME, duration: 40 * FRAME, mediaId: "m1", linkId: "L1" }),
					aud({ id: "a2", startTime: 45 * FRAME, duration: 40 * FRAME, trimStart: 5 * FRAME, mediaId: "m2" }),
				],
				[aud({ id: "aov", startTime: 3 * FRAME, duration: 20 * FRAME, mediaId: "mov", linkId: "LOV" })],
			],
		});
		assertParity(scene);
		// Spot-check a couple of concrete values.
		const map = buildAvSyncMap({ tracks: scene, fps: FPS });
		expect(map.get("v1")?.offsetFrames).toBe(12);
		expect(map.has("v3")).toBe(false);
	});

	test("recomputes for a new tracks reference", () => {
		const before = tracks({
			main: [vid({ id: "v", startTime: 0, duration: 40 * FRAME, mediaId: "m", linkId: "L" })],
			audio: [
				[aud({ id: "a", startTime: 108 * FRAME, duration: 40 * FRAME, mediaId: "m", linkId: "L" })],
			],
		});
		const after = tracks({
			main: [vid({ id: "v", startTime: 0, duration: 40 * FRAME, mediaId: "m", linkId: "L" })],
			audio: [
				[aud({ id: "a", startTime: 4 * FRAME, duration: 40 * FRAME, mediaId: "m", linkId: "L" })],
			],
		});
		expect(buildAvSyncMap({ tracks: before, fps: FPS }).get("v")?.offsetFrames).toBe(108);
		expect(buildAvSyncMap({ tracks: after, fps: FPS }).get("v")?.offsetFrames).toBe(4);
	});
});
