import { describe, expect, test } from "bun:test";
import {
	assetContentKey,
	float32MonoToWav,
	isAssetCacheHit,
	shouldTranscribeAsset,
	type AssetTranscriptEntry,
} from "@/features/ai-generate/director/asset-transcribe-helpers";

function entry(partial: Partial<AssetTranscriptEntry>): AssetTranscriptEntry {
	return { segments: [], createdAt: 0, ...partial };
}

describe("assetContentKey", () => {
	test("is size:lastModified (project-id independent)", () => {
		expect(
			assetContentKey({
				file: { size: 1024, lastModified: 999 },
				type: "video",
			}),
		).toBe("1024:999");
	});
});

describe("shouldTranscribeAsset", () => {
	test("skips images and known-silent assets, keeps audible video/audio", () => {
		const file = { size: 1, lastModified: 1 };
		expect(shouldTranscribeAsset({ file, type: "image" })).toBe(false);
		expect(
			shouldTranscribeAsset({ file, type: "video", hasAudio: false }),
		).toBe(false);
		expect(shouldTranscribeAsset({ file, type: "video" })).toBe(true);
		expect(
			shouldTranscribeAsset({ file, type: "audio", hasAudio: true }),
		).toBe(true);
	});
});

describe("isAssetCacheHit", () => {
	test("null entry is never a hit", () => {
		expect(isAssetCacheHit(null, false)).toBe(false);
		expect(isAssetCacheHit(undefined, true)).toBe(false);
	});

	test("segment-only entry hits when words not wanted, misses when wanted", () => {
		const e = entry({ segments: [{ start: 0, end: 1, text: "hi" }] });
		expect(isAssetCacheHit(e, false)).toBe(true);
		expect(isAssetCacheHit(e, true)).toBe(false);
	});

	test("entry with words, or words-unavailable, hits a wantWords request", () => {
		expect(
			isAssetCacheHit(entry({ words: [{ start: 0, end: 1, text: "hi" }] }), true),
		).toBe(true);
		expect(isAssetCacheHit(entry({ wordsUnavailable: true }), true)).toBe(true);
	});

	test("an empty (silent) cached transcript is still a valid hit", () => {
		expect(isAssetCacheHit(entry({ segments: [] }), false)).toBe(true);
	});
});

describe("float32MonoToWav", () => {
	test("writes a 44-byte header + 16-bit PCM data of the right size", async () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
		const blob = float32MonoToWav({ samples, sampleRate: 16000 });
		expect(blob.type).toBe("audio/wav");
		expect(blob.size).toBe(44 + samples.length * 2);
		const view = new DataView(await blob.arrayBuffer());
		const tag = (offset: number) =>
			String.fromCharCode(
				view.getUint8(offset),
				view.getUint8(offset + 1),
				view.getUint8(offset + 2),
				view.getUint8(offset + 3),
			);
		expect(tag(0)).toBe("RIFF");
		expect(tag(8)).toBe("WAVE");
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(16000); // sample rate
	});
});
