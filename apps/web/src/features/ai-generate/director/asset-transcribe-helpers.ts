/**
 * Pure, wasm/browser-free helpers for per-asset (bin-wide) transcription. Kept in
 * a leaf so the cache-key, skip, and cache-hit logic are bun-testable without
 * pulling in the transcription worker / mediabunny decode path.
 */

import type {
	TranscriptSegmentLite,
	TranscriptWordLite,
} from "@/features/transcription/transcript-cache";
import type { SpeechFeatures } from "./types";

/** One cached per-asset transcript (id is added by the IndexedDB adapter). */
export interface AssetTranscriptEntry {
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
	/** Set when words were requested but the model couldn't produce them. */
	wordsUnavailable?: boolean;
	/** Per-segment audio features (loudness/wpm/filler), for take-ranking. */
	features?: SpeechFeatures[];
	createdAt: number;
}

/** A transcribed bin clip in SOURCE coordinates (segment times are clip-relative). */
export interface BinClipTranscript {
	assetId: string;
	name: string;
	durationSec: number;
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
	wordsUnavailable?: boolean;
	features?: SpeechFeatures[];
}

/** Minimal asset shape these helpers read. */
export interface AssetKeyFields {
	file: { size: number; lastModified: number };
	type: "image" | "video" | "audio";
	hasAudio?: boolean;
}

/**
 * Content-stable cache key: `size:lastModified`. Independent of the per-project
 * asset id, so the same file re-imported into another project hits the cache.
 */
export function assetContentKey(asset: AssetKeyFields): string {
	return `${asset.file.size}:${asset.file.lastModified}`;
}

/** Images and known-silent assets are not worth transcribing. */
export function shouldTranscribeAsset(asset: AssetKeyFields): boolean {
	if (asset.type === "image") return false;
	if (asset.hasAudio === false) return false;
	return true;
}

/**
 * A cache entry satisfies the request when it exists AND (words weren't wanted OR
 * the entry has words OR the model already proved it can't make them). Mirrors
 * the timeline transcript-cache hit rule so a `wantWords` miss doesn't loop.
 */
export function isAssetCacheHit(
	entry: AssetTranscriptEntry | null | undefined,
	wantWords: boolean,
): entry is AssetTranscriptEntry {
	if (!entry) return false;
	return (
		!wantWords || entry.words !== undefined || entry.wordsUnavailable === true
	);
}

/** Encode mono Float32 PCM as a 16-bit WAV blob (for the cloud upload path). */
export function float32MonoToWav({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): Blob {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeString = ({ offset, str }: { offset: number; str: string }) => {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	};
	writeString({ offset: 0, str: "RIFF" });
	view.setUint32(4, 36 + dataSize, true);
	writeString({ offset: 8, str: "WAVE" });
	writeString({ offset: 12, str: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeString({ offset: 36, str: "data" });
	view.setUint32(40, dataSize, true);
	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
		offset += 2;
	}
	return new Blob([buffer], { type: "audio/wav" });
}
