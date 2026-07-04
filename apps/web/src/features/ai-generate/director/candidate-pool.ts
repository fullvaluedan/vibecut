/**
 * Cross-bin candidate pool (FrameCut auto-assemble, P1).
 *
 * Flattens every transcribed bin clip into a flat list of candidate spans in
 * SOURCE coordinates — one per transcript segment, across ALL clips including
 * unused retakes. This is the unit the assembler reasons over and the take
 * clusterer groups (`buildTakeClustersFromPool`). Pure + wasm-free → bun-testable.
 */

import type { SpeechFeatures } from "./types";
import type { BinClipTranscript } from "./asset-transcribe-helpers";

/** One selectable span of source footage with its transcript + audio signal. */
export interface CandidateSpan {
	/** Stable within one pool build: `${assetId}@${sourceStartSec}`. */
	id: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
	text: string;
	/** Per-clip audio features for this span, when available. */
	audio?: SpeechFeatures;
}

/** Quantize a second to a stable join key (matches take-clusters). */
function startKey(sec: number): number {
	return Math.round(sec * 1000) / 1000;
}

/**
 * Build the candidate pool from per-asset transcripts, joining each segment to
 * its per-clip audio features (by start-second) when provided. Segment times are
 * already clip-relative (source coordinates), so no timeline mapping is needed.
 */
export function buildCandidatePool({
	clips,
	featuresByAsset,
}: {
	clips: readonly BinClipTranscript[];
	featuresByAsset?: ReadonlyMap<string, readonly SpeechFeatures[]>;
}): CandidateSpan[] {
	const pool: CandidateSpan[] = [];
	for (const clip of clips) {
		const featureByStart = new Map<number, SpeechFeatures>();
		const features = featuresByAsset?.get(clip.assetId);
		if (features) {
			for (const f of features) featureByStart.set(startKey(f.startSec), f);
		}
		for (const seg of clip.segments) {
			pool.push({
				id: `${clip.assetId}@${seg.start.toFixed(3)}`,
				assetId: clip.assetId,
				sourceStartSec: seg.start,
				sourceEndSec: seg.end,
				text: seg.text,
				audio: featureByStart.get(startKey(seg.start)),
			});
		}
	}
	return pool;
}
