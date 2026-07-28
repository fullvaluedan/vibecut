/**
 * Golden-footage eval, shared fixture shape (U3). The prepare script writes it;
 * the runner reads it. Beyond the raw/final transcripts, an enriched fixture now
 * carries the REAL signal-table inputs — per-segment speech features + a coarse
 * energy envelope + the clip geometry — so the LLM passes see the same loudness /
 * wpm / filler / silence / importance signals the app computes live, instead of
 * stubs (KTD3/R2). The audio fields are optional so the runner can still load an
 * old transcript-only fixture (and tell the user to regenerate for `--llm`).
 */
import {
	computeEnergyEnvelope,
	computeSpeechFeatures,
	ENERGY_WINDOW_SEC,
} from "../audio-features";
import type { SpeechFeatures } from "../types";

/** Hop shared by the fixture envelope and the per-segment feature windows. */
export const FIXTURE_ENVELOPE_WINDOW_SEC = ENERGY_WINDOW_SEC;

export interface FixtureWord {
	text: string;
	start: number;
	end: number;
}
export interface FixtureSegment {
	text: string;
	start: number;
	end: number;
}
/** A video clip's span on the assembled raw timeline, in seconds (KTD7). */
export interface FixtureClipSpan {
	startSec: number;
	endSec: number;
}
/** Pseudo source element per raw file (assetId = filename) for source mapping. */
export interface FixtureElement {
	id: string;
	mediaId: string;
	/** Timeline start, in ticks. */
	startTime: number;
	/** On-timeline duration, in ticks. */
	duration: number;
	/** Source in-point, in ticks (always 0 for a whole-file pseudo clip). */
	trimStart: number;
}
/** Pseudo bin asset per raw file (id = name = filename). */
export interface FixtureAsset {
	id: string;
	name: string;
	durationSec: number;
}

export interface DirectorEvalFixture {
	name: string;
	rawWords: FixtureWord[];
	finalWords: FixtureWord[];
	rawSegments?: FixtureSegment[];
	// --- U3 audio-feature enrichment (optional; absent on legacy fixtures) ---
	/** Per-segment speech features, PARALLEL to `rawSegments`. */
	features?: SpeechFeatures[];
	/** Coarse RMS energy envelope over the raw timeline (windowed at
	 * `envelopeWindowSec`), rounded for JSON size. */
	envelope?: number[];
	/** Hop used for `envelope` and the feature windows. */
	envelopeWindowSec?: number;
	/** Per-raw-file clip spans on the assembled timeline. */
	clipSpans?: FixtureClipSpan[];
	/** Per-raw-file pseudo source elements (KTD7). */
	elements?: FixtureElement[];
	/** Per-raw-file pseudo bin assets (KTD7). */
	assets?: FixtureAsset[];
	/** Total raw-timeline duration, seconds. */
	totalSec?: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function roundFeature(f: SpeechFeatures): SpeechFeatures {
	return {
		startSec: round3(f.startSec),
		endSec: round3(f.endSec),
		energy: round3(f.energy),
		loudnessRelative: round3(f.loudnessRelative),
		wpm: round3(f.wpm),
		wordCount: f.wordCount,
		fillerCandidate: f.fillerCandidate,
	};
}

/**
 * Compute the fixture's audio features the SAME way the app does at runtime:
 * one shared RMS envelope over the whole (assembled) raw buffer, then per-segment
 * features off that envelope (KTD3). Values are rounded to 3 decimals for JSON
 * size unless `round` is false. Pure — the caller supplies the decoded samples.
 */
export function buildFixtureAudioFeatures({
	samples,
	sampleRate,
	segments,
	windowSec = ENERGY_WINDOW_SEC,
	round = true,
}: {
	samples: Float32Array;
	sampleRate: number;
	segments: readonly FixtureSegment[];
	windowSec?: number;
	round?: boolean;
}): { envelope: number[]; features: SpeechFeatures[] } {
	const envelope = computeEnergyEnvelope({ samples, sampleRate, windowSec });
	// Features come off the FULL-precision envelope; only the stored copies round.
	const features = computeSpeechFeatures({ segments, envelope, windowSec });
	if (!round) return { envelope, features };
	return {
		envelope: envelope.map(round3),
		features: features.map(roundFeature),
	};
}
