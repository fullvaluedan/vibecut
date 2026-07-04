/**
 * Bin-wide per-asset transcription (FrameCut auto-assemble, P0).
 *
 * Transcribes EACH bin clip independently in its own SOURCE coordinates — no
 * timeline, no placement — and caches the result per-asset by a content hash
 * (`size:lastModified`) in a dedicated IndexedDB store, so it is reused across
 * runs AND across projects (a re-imported file hits the cache). Routes to the
 * same Groq-cloud / in-browser backend as the timeline transcriber.
 */

import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { decodeAssetAudioToFloat32 } from "@/media/audio";
import { encodeAudioForUpload } from "@/media/audio-encode";
import { checkTranscribeUploadSize } from "@/media/transcribe-upload-limit";
import { transcriptionService } from "@/services/transcription/service";
import { selectAnalysisModel } from "@/transcription/analysis-model";
import {
	buildTranscribeHeaders,
	useAiSettingsStore,
} from "@/features/ai-generate/store";
import { parseCloudTranscript } from "@/features/transcription/transcript-cache";
import type { MediaAsset } from "@/media/types";
import { computeSpeechFeatures } from "./audio-features";
import {
	assetContentKey,
	float32MonoToWav,
	isAssetCacheHit,
	shouldTranscribeAsset,
	type AssetTranscriptEntry,
	type BinClipTranscript,
} from "./asset-transcribe-helpers";

export type { AssetTranscriptEntry, BinClipTranscript };

const assetTranscriptStore = new IndexedDBAdapter<AssetTranscriptEntry>({
	dbName: "video-editor-asset-transcripts",
	storeName: "asset-transcripts",
	version: 1,
});

async function getCachedAssetTranscript(
	key: string,
): Promise<AssetTranscriptEntry | null> {
	try {
		return await assetTranscriptStore.get(key);
	} catch {
		return null;
	}
}

async function saveAssetTranscript({
	key,
	entry,
}: {
	key: string;
	entry: AssetTranscriptEntry;
}): Promise<void> {
	try {
		await assetTranscriptStore.set({ key, value: entry });
	} catch {
		// the cache is an optimization — quota errors must never break a run
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Cancelled");
}

async function transcribeViaCloud({
	samples,
	sampleRate,
	signal,
}: {
	samples: Float32Array;
	sampleRate: number;
	signal?: AbortSignal;
}): Promise<AssetTranscriptEntry> {
	const wav = float32MonoToWav({ samples, sampleRate });
	// Compress to a small Opus/AAC blob so a long clip stays under Groq's real
	// per-request cap (~25 MB free tier); fall back to the WAV if the browser can't
	// encode or the encode wedges.
	const encoded = await encodeAudioForUpload({
		audioBlob: wav,
		durationSec: sampleRate > 0 ? samples.length / sampleRate : 0,
	});
	const upload = encoded ?? { blob: wav, filename: "clip.wav" };
	// Refuse an oversized upload instead of letting Groq 413 (only the raw-WAV
	// fallback on a very long clip can reach this).
	const sizeCheck = checkTranscribeUploadSize(upload.blob.size);
	if (!sizeCheck.ok) throw new Error(sizeCheck.error);
	const form = new FormData();
	form.append("audio", upload.blob, upload.filename);
	const response = await fetch("/api/transcribe", {
		method: "POST",
		headers: buildTranscribeHeaders(),
		body: form,
		signal,
	});
	if (!response.ok) {
		const detail: unknown = await response.json().catch(() => null);
		const message =
			isRecord(detail) && typeof detail.error === "string"
				? detail.error
				: `Cloud transcription failed (${response.status}).`;
		throw new Error(message);
	}
	const { segments, words } = parseCloudTranscript(await response.json());
	return { segments, words, wordsUnavailable: undefined, createdAt: Date.now() };
}

async function transcribeInBrowser({
	samples,
	durationSec,
	wantWords,
}: {
	samples: Float32Array;
	durationSec: number;
	wantWords: boolean;
}): Promise<AssetTranscriptEntry> {
	const transcript = await transcriptionService.transcribe({
		audioData: samples,
		modelId: selectAnalysisModel({ durationSec }),
		wordTimestamps: wantWords,
	});
	const segments = transcript.segments.map((s) => ({
		start: s.start,
		end: s.end,
		text: s.text,
	}));
	const words = transcript.words?.map((w) => ({
		start: w.start,
		end: w.end,
		text: w.text,
	}));
	const wordsUnavailable = wantWords
		? (transcript.wordsUnavailable ?? !words)
		: undefined;
	return { segments, words, wordsUnavailable, createdAt: Date.now() };
}

/**
 * Transcribe a single bin clip (cache hit → instant). Returns null when the asset
 * has no decodable audio. Does NOT throw on a cache-write failure.
 */
export async function transcribeAsset({
	asset,
	wantWords = false,
	signal,
}: {
	asset: MediaAsset;
	wantWords?: boolean;
	signal?: AbortSignal;
}): Promise<AssetTranscriptEntry | null> {
	const key = assetContentKey(asset);
	const cached = await getCachedAssetTranscript(key);
	// Fast path: the cached transcript satisfies the request AND already has the
	// audio features — no decode needed.
	if (isAssetCacheHit(cached, wantWords) && cached.features !== undefined) {
		return cached;
	}

	const decoded = await decodeAssetAudioToFloat32({ asset });
	// No decodable audio — surface the cached transcript (sans features) if any.
	if (!decoded) return cached ?? null;
	throwIfAborted(signal);

	// Reuse a cached transcript when it already satisfies the request (just add the
	// missing features); otherwise transcribe the decoded audio.
	let base: AssetTranscriptEntry;
	if (isAssetCacheHit(cached, wantWords)) {
		base = cached;
	} else {
		const aiSettings = useAiSettingsStore.getState();
		const useCloud =
			aiSettings.transcriptionBackend === "cloud" && !!aiSettings.groqApiKey;
		base = useCloud
			? await transcribeViaCloud({
					samples: decoded.samples,
					sampleRate: decoded.sampleRate,
					signal,
				})
			: await transcribeInBrowser({
					samples: decoded.samples,
					durationSec: asset.duration ?? 0,
					wantWords,
				});
	}

	const entry: AssetTranscriptEntry = {
		...base,
		features: computeSpeechFeatures({
			segments: base.segments.map((s) => ({
				start: s.start,
				end: s.end,
				text: s.text,
			})),
			samples: decoded.samples,
			sampleRate: decoded.sampleRate,
		}),
	};
	await saveAssetTranscript({ key, entry });
	return entry;
}

export interface TranscribeBinProgress {
	/** 0-based index of the clip currently being transcribed. */
	index: number;
	total: number;
	assetName: string;
	/** True when this clip was already cached (no transcription run). */
	cached: boolean;
}

/**
 * Transcribe every transcribable bin clip, SERIALLY (one transcription worker).
 * Skips images/known-silent assets, tolerates a single clip's decode/transcribe
 * failure (logs + continues), and aborts cleanly between clips. Clips that yield
 * no speech are omitted from the result.
 */
export async function transcribeBin({
	assets,
	wantWords = false,
	signal,
	onProgress,
}: {
	assets: readonly MediaAsset[];
	wantWords?: boolean;
	signal?: AbortSignal;
	onProgress?: (p: TranscribeBinProgress) => void;
}): Promise<BinClipTranscript[]> {
	const transcribable = assets.filter((asset) => shouldTranscribeAsset(asset));
	const out: BinClipTranscript[] = [];

	for (let i = 0; i < transcribable.length; i++) {
		throwIfAborted(signal);
		const asset = transcribable[i];
		const cached = isAssetCacheHit(
			await getCachedAssetTranscript(assetContentKey(asset)),
			wantWords,
		);
		onProgress?.({
			index: i,
			total: transcribable.length,
			assetName: asset.name,
			cached,
		});

		try {
			const entry = await transcribeAsset({ asset, wantWords, signal });
			if (entry && entry.segments.length > 0) {
				out.push({
					assetId: asset.id,
					name: asset.name,
					durationSec: asset.duration ?? 0,
					segments: entry.segments,
					words: entry.words,
					wordsUnavailable: entry.wordsUnavailable,
					features: entry.features,
				});
			}
		} catch (error) {
			if (signal?.aborted) {
				throw error instanceof Error ? error : new Error("Cancelled");
			}
			// One bad clip (undecodable audio, model error) must not abort the bin.
			console.warn(`[asset-transcribe] skipped "${asset.name}":`, error);
		}
	}

	return out;
}
