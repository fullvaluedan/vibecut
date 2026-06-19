/**
 * Per-asset catalog the Director surfaces to the LLM planner (U2).
 *
 * Today the planner only sees a 6-char `src` hash per signal-table row, so it has
 * no model of the bin: which clips exist, how long each is, what each says. This
 * builds a compact per-asset summary — name, duration, timeline span, segment
 * count, first/last line, and aggregate audio quality — from the per-asset
 * transcript (`groupTranscriptByAsset`) joined to the per-segment audio features.
 *
 * Pure over injected inputs (no editor/wasm import) so it is bun-testable; the
 * orchestrator does the grouping + feature decode and passes the results in. A
 * synthesized "gist" is intentionally deferred — first/last line covers LLM
 * orientation for scripted talking-head clips (see the plan's U2 open question).
 * Clips with no speech (no attributed segments) are omitted: they carry no take
 * signal, which is what this catalog feeds.
 */

import type { AssetTranscript } from "./source-map";
import type { SpeechFeatures } from "./types";

/** The minimal asset metadata the catalog needs — the caller maps MediaAsset to this. */
export interface CatalogAsset {
	id: string;
	/** Display name / filename. */
	name: string;
	/** Source duration in seconds. */
	durationSec: number;
}

/** Aggregate audio quality across an asset's speech segments (file-relative). */
export interface AssetAudioSummary {
	/** Mean of per-segment loudnessRelative, 0..1. */
	meanLoudness: number;
	/** Mean speaking rate (words/min) across segments. */
	meanWpm: number;
	/** Fraction of the asset's segments flagged as filler/false-start, 0..1. */
	fillerShare: number;
}

/** One catalog row: what a single source clip is and roughly contains. */
export interface AssetCatalogEntry {
	assetId: string;
	name: string;
	durationSec: number;
	/** Earliest timeline second this asset covers. */
	timelineStartSec: number;
	/** Latest timeline second this asset covers. */
	timelineEndSec: number;
	/** Number of attributed transcript segments. */
	segmentCount: number;
	/** First spoken line (trimmed/truncated) — LLM orientation. */
	firstLine: string;
	/** Last spoken line (trimmed/truncated). */
	lastLine: string;
	/** Aggregate audio; absent when no features joined to this asset. */
	audio?: AssetAudioSummary;
}

/** Longest line we keep for first/last preview — enough to orient, not a wall. */
const MAX_LINE_CHARS = 100;

function previewLine(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS - 1)}…` : trimmed;
}

/** Key a feature row by its start second (3-decimal) so segments can join to it. */
function startKey(sec: number): number {
	return Math.round(sec * 1000) / 1000;
}

/**
 * Build the per-asset catalog. `assetTranscripts` come from `groupTranscriptByAsset`
 * (first-appearance order, gap segments already dropped); `features` is the
 * per-timeline-segment audio array (joined by segment start second); `assets`
 * supplies name + duration. Insertion order of the result mirrors
 * `assetTranscripts`. Assets absent from `assetTranscripts` (no speech) are omitted.
 */
export function buildAssetCatalog({
	assetTranscripts,
	features,
	assets,
}: {
	assetTranscripts: readonly AssetTranscript[];
	features: readonly SpeechFeatures[];
	assets: readonly CatalogAsset[];
}): AssetCatalogEntry[] {
	const metaById = new Map<string, CatalogAsset>();
	for (const asset of assets) metaById.set(asset.id, asset);

	const featureByStart = new Map<number, SpeechFeatures>();
	for (const f of features) featureByStart.set(startKey(f.startSec), f);

	const entries: AssetCatalogEntry[] = [];
	for (const transcript of assetTranscripts) {
		const segments = transcript.segments;
		if (segments.length === 0) continue;

		const meta = metaById.get(transcript.assetId);
		let timelineStartSec = Number.POSITIVE_INFINITY;
		let timelineEndSec = Number.NEGATIVE_INFINITY;

		let loudnessSum = 0;
		let wpmSum = 0;
		let fillerCount = 0;
		let featuredCount = 0;

		for (const seg of segments) {
			timelineStartSec = Math.min(timelineStartSec, seg.start);
			timelineEndSec = Math.max(timelineEndSec, seg.end);
			const f = featureByStart.get(startKey(seg.start));
			if (f) {
				loudnessSum += f.loudnessRelative;
				wpmSum += f.wpm;
				if (f.fillerCandidate) fillerCount += 1;
				featuredCount += 1;
			}
		}

		const entry: AssetCatalogEntry = {
			assetId: transcript.assetId,
			name: meta?.name ?? transcript.assetId.slice(0, 8),
			durationSec: meta?.durationSec ?? 0,
			timelineStartSec,
			timelineEndSec,
			segmentCount: segments.length,
			firstLine: previewLine(segments[0].text),
			lastLine: previewLine(segments[segments.length - 1].text),
			...(featuredCount > 0
				? {
						audio: {
							meanLoudness: loudnessSum / featuredCount,
							meanWpm: wpmSum / featuredCount,
							fillerShare: fillerCount / featuredCount,
						},
					}
				: {}),
		};
		entries.push(entry);
	}

	return entries;
}
