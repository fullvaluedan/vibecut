import { describe, expect, it } from "bun:test";
import {
	CODEC_PREFERENCE,
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
