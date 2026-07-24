import { describe, expect, test } from "bun:test";
import type { AudioElement, AudioTrack, SceneTracks, VideoTrack } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { timelineHasAudio, timelineAudioNeedsChunking } from "../audio";

// A 15 min timeline is comfortably past the ~9.5 min single-buffer cap, so it
// takes the chunked export path - the one that used to declare an empty audio
// trak for a silent mix.
const LONG_DURATION = 15 * 60 * TICKS_PER_SECOND;

function audioElement({ id, muted }: { id: string; muted: boolean }): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		sourceType: "upload",
		mediaId: "m1",
		startTime: 0,
		duration: 10 * TICKS_PER_SECOND,
		trimStart: 0,
		trimEnd: 0,
		params: { muted },
	} as unknown as AudioElement;
}

function scene({ audio }: { audio: AudioElement[] }): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		elements: [],
		muted: false,
		hidden: false,
	} as unknown as VideoTrack;
	const audioTrack: AudioTrack = {
		id: "a1",
		type: "audio",
		name: "A1",
		elements: audio,
		muted: false,
	} as unknown as AudioTrack;
	return { overlay: [], main, audio: [audioTrack] };
}

describe("audio-track gate for long (chunked) exports", () => {
	test("the 15 min timeline really does take the chunked path", () => {
		expect(timelineAudioNeedsChunking({ duration: LONG_DURATION })).toBe(true);
	});

	test("a long timeline with NO audio elements declares no audio track", () => {
		expect(timelineHasAudio({ tracks: scene({ audio: [] }), mediaAssets: [] })).toBe(
			false,
		);
	});

	test("a long timeline with ALL audio muted declares no audio track", () => {
		const tracks = scene({
			audio: [audioElement({ id: "a", muted: true }), audioElement({ id: "b", muted: true })],
		});
		expect(timelineHasAudio({ tracks, mediaAssets: [] })).toBe(false);
	});

	test("a long timeline with at least one audible element still streams audio", () => {
		const tracks = scene({
			audio: [audioElement({ id: "a", muted: true }), audioElement({ id: "b", muted: false })],
		});
		expect(timelineHasAudio({ tracks, mediaAssets: [] })).toBe(true);
	});
});
