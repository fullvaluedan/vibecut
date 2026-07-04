import { describe, expect, it } from "bun:test";
import {
	CODEC_PREFERENCE,
	computeEncodeTimeoutMs,
	encoderProbe,
	uploadInfoForCodec,
} from "@/media/audio-encode-codecs";

/**
 * The upload filename's extension is how Groq detects the container/codec, so
 * the codec->filename/mime mapping is load-bearing. Imported from the leaf so
 * the test stays free of the mediabunny / AudioContext pull-in.
 */
describe("audio-encode-codecs", () => {
	it("prefers Opus, then AAC (Opus is smaller and Groq-accepted)", () => {
		expect(CODEC_PREFERENCE).toEqual(["opus", "aac"]);
	});

	it("maps opus to a WebM container", () => {
		expect(uploadInfoForCodec("opus")).toEqual({
			filename: "timeline.webm",
			mimeType: "audio/webm",
		});
	});

	it("maps aac to an m4a/MP4 container", () => {
		expect(uploadInfoForCodec("aac")).toEqual({
			filename: "timeline.m4a",
			mimeType: "audio/mp4",
		});
	});

	it("probes opus as 'opus' and aac as an mp4a codec string", () => {
		expect(encoderProbe("opus").webCodec).toBe("opus");
		expect(encoderProbe("aac").webCodec).toBe("mp4a.40.2");
		// Low, STT-adequate bitrates.
		expect(encoderProbe("opus").bitrate).toBeLessThanOrEqual(48000);
		expect(encoderProbe("aac").bitrate).toBeLessThanOrEqual(64000);
	});
});

/**
 * The encode timeout was a flat 20s, tuned to catch a WebCodecs pipeline WEDGE
 * on a SHORT ripple-cut timeline. That same flat ceiling forced Dan's genuine
 * 32 min encode to fall back to the oversized WAV that then 413'd. It now scales
 * with duration: a real long encode gets a fair shot, while a short clip keeps
 * the fast wedge protection and a truly wedged pipeline still dies in bounded time.
 */
describe("computeEncodeTimeoutMs", () => {
	it("keeps the 20s floor for a short clip (wedge protection unchanged)", () => {
		expect(computeEncodeTimeoutMs(0)).toBe(20_000);
		expect(computeEncodeTimeoutMs(10)).toBe(20_000 + 10 * 40);
	});

	it("gives a long clip more time than the old flat 20s", () => {
		// 5 min of audio: enough headroom that a legitimate encode can finish.
		expect(computeEncodeTimeoutMs(300)).toBeGreaterThan(20_000);
	});

	it("caps at 90s so a wedged 32 min encode still degrades in bounded time", () => {
		// Dan's real 32:19 (~1939s) case: the scaled value is far past the ceiling.
		expect(computeEncodeTimeoutMs(1939)).toBe(90_000);
	});

	it("never returns below the floor for a negative/garbage duration", () => {
		expect(computeEncodeTimeoutMs(-100)).toBe(20_000);
	});
});
