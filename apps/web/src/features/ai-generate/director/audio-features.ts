/**
 * Per-segment speech/audio features for the Director (U2).
 *
 * Pure, wasm-free math over a decoded Float32 mono buffer (the same buffer
 * `remove-silences.ts` derives via `decodeAudioToFloat32`) plus the timeline
 * transcript: an RMS energy envelope, file-relative loudness, speaking rate, and
 * a heuristic filler detector. Energy/loudness are RELATIVE WITHIN THE FILE —
 * absolute RMS is not portable across recordings (KTD note).
 *
 * Word-level confidence (`WordToken.confidence`) is treated as a HINT only: the
 * default filler decision uses the deterministic FALLBACK (filler-word ratio +
 * low relative energy), because transformers.js word timing/confidence is
 * heuristic and must be live-spike-verified before being trusted (KTD5). The
 * word-consuming helpers below are ready for that path once the spike confirms it.
 */

import type { SpeechFeatures, SpeechSegment, WordToken } from "./types";

/** RMS window length, mirroring `remove-silences.ts` WINDOW_SEC. */
export const ENERGY_WINDOW_SEC = 0.05;
/** A segment whose words are ≥ this fraction filler reads as a filler candidate. */
export const FILLER_RATIO_THRESHOLD = 0.5;
/** Below this fraction of the file's loudest segment, a short segment reads as filler. */
export const LOW_ENERGY_RATIO = 0.15;
/** Confidence below this flags a word as a filler/uncertain candidate (spike-gated use). */
export const LOW_CONFIDENCE = 0.4;

/**
 * Common spoken fillers / discourse markers. Matched case-insensitively against
 * whole words; multi-word markers ("you know") are matched as phrases.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
	"um",
	"uh",
	"uhm",
	"erm",
	"hmm",
	"like",
	"so",
	"basically",
	"literally",
	"actually",
	"right",
	"okay",
	"ok",
	"well",
]);
const FILLER_PHRASES: readonly string[] = ["you know", "i mean", "sort of", "kind of"];

/** Split text into lowercase word tokens (letters/digits/apostrophes). */
export function tokenizeWords(text: string): string[] {
	const matches = text.toLowerCase().match(/[a-z0-9']+/g);
	return matches ?? [];
}

export function countWords(text: string): number {
	return tokenizeWords(text).length;
}

/**
 * RMS energy envelope: one value per `windowSec` window of the buffer. Mirrors
 * the windowing in `detectSilentRangesSec` so energy and silence agree.
 */
export function computeEnergyEnvelope({
	samples,
	sampleRate,
	windowSec = ENERGY_WINDOW_SEC,
}: {
	samples: Float32Array;
	sampleRate: number;
	windowSec?: number;
}): number[] {
	const windowSize = Math.max(1, Math.round(windowSec * sampleRate));
	const windowCount = Math.floor(samples.length / windowSize);
	const envelope = new Array<number>(windowCount);
	for (let w = 0; w < windowCount; w++) {
		let sum = 0;
		const base = w * windowSize;
		for (let i = 0; i < windowSize; i++) {
			const s = samples[base + i];
			sum += s * s;
		}
		envelope[w] = Math.sqrt(sum / windowSize);
	}
	return envelope;
}

/** Mean envelope energy over `[startSec, endSec)`; 0 for an empty/out-of-range span. */
export function meanEnergyOverRange({
	envelope,
	windowSec,
	startSec,
	endSec,
}: {
	envelope: readonly number[];
	windowSec: number;
	startSec: number;
	endSec: number;
}): number {
	if (endSec <= startSec || envelope.length === 0) {
		return 0;
	}
	const from = Math.max(0, Math.floor(startSec / windowSec));
	const to = Math.min(envelope.length, Math.ceil(endSec / windowSec));
	if (to <= from) {
		return 0;
	}
	let sum = 0;
	for (let i = from; i < to; i++) {
		sum += envelope[i];
	}
	return sum / (to - from);
}

/** Words per minute; 0 when there are no words or the span is non-positive. */
export function speakingRateWpm({
	wordCount,
	durationSec,
}: {
	wordCount: number;
	durationSec: number;
}): number {
	if (wordCount <= 0 || durationSec <= 0) {
		return 0;
	}
	return (wordCount / durationSec) * 60;
}

/** Fraction of a segment's words that are fillers (whole-word + phrase match). */
export function fillerRatio(text: string): number {
	const words = tokenizeWords(text);
	if (words.length === 0) {
		return 0;
	}
	let fillerHits = words.filter((w) => FILLER_WORDS.has(w)).length;
	const lower = ` ${text.toLowerCase()} `;
	for (const phrase of FILLER_PHRASES) {
		if (lower.includes(` ${phrase} `)) {
			// Count each phrase as covering its word span.
			fillerHits += phrase.split(" ").length;
		}
	}
	return Math.min(1, fillerHits / words.length);
}

/**
 * Heuristic filler/false-start detector (the spike-independent FALLBACK): a
 * segment is a candidate when it is filler-word dominated, OR it is short and far
 * quieter than the file's loudest segment (a trailing-off mumble).
 */
export function isFillerSegment({
	text,
	energy,
	maxEnergy,
	durationSec,
}: {
	text: string;
	energy: number;
	maxEnergy: number;
	durationSec: number;
}): boolean {
	if (fillerRatio(text) >= FILLER_RATIO_THRESHOLD) {
		return true;
	}
	const relative = maxEnergy > 0 ? energy / maxEnergy : 0;
	return durationSec <= 1.5 && relative <= LOW_ENERGY_RATIO && countWords(text) > 0;
}

/**
 * Word indices whose confidence is below `threshold` — the seam the confidence
 * path will use ONCE the live spike validates that the model's word confidence is
 * meaningful. Not wired into the default filler decision (KTD5 spike-first).
 */
export function lowConfidenceWordIndices({
	words,
	threshold = LOW_CONFIDENCE,
}: {
	words: readonly WordToken[];
	threshold?: number;
}): number[] {
	const indices: number[] = [];
	for (let i = 0; i < words.length; i++) {
		const c = words[i].confidence;
		if (typeof c === "number" && c < threshold) {
			indices.push(i);
		}
	}
	return indices;
}

/**
 * Compute per-segment `SpeechFeatures` from a decoded mono buffer + transcript.
 * Loudness is each segment's energy as a fraction of the loudest segment, so it
 * is comparable within (but not across) the file. Word count prefers word-level
 * tokens when present, else falls back to tokenizing the text.
 */
export function computeSpeechFeatures({
	segments,
	samples,
	sampleRate,
	windowSec = ENERGY_WINDOW_SEC,
	envelope: precomputedEnvelope,
}: {
	segments: readonly SpeechSegment[];
	/** Decoded mono buffer — required unless a precomputed `envelope` is supplied. */
	samples?: Float32Array;
	/** Sample rate of `samples` — required unless `envelope` is supplied. */
	sampleRate?: number;
	windowSec?: number;
	/** Precomputed energy envelope; when supplied, skips recomputing it from `samples`. */
	envelope?: readonly number[];
}): SpeechFeatures[] {
	const envelope =
		precomputedEnvelope ??
		computeEnergyEnvelope({
			samples: samples ?? new Float32Array(0),
			sampleRate: sampleRate ?? 1,
			windowSec,
		});

	const rows = segments.map((seg) => {
		const energy = meanEnergyOverRange({
			envelope,
			windowSec,
			startSec: seg.start,
			endSec: seg.end,
		});
		const wordCount = seg.words ? seg.words.length : countWords(seg.text);
		const wpm = speakingRateWpm({ wordCount, durationSec: seg.end - seg.start });
		return { seg, energy, wordCount, wpm };
	});

	const maxEnergy = rows.reduce((max, r) => Math.max(max, r.energy), 0);

	return rows.map((r) => ({
		startSec: r.seg.start,
		endSec: r.seg.end,
		energy: r.energy,
		loudnessRelative: maxEnergy > 0 ? r.energy / maxEnergy : 0,
		wpm: r.wpm,
		wordCount: r.wordCount,
		fillerCandidate: isFillerSegment({
			text: r.seg.text,
			energy: r.energy,
			maxEnergy,
			durationSec: r.seg.end - r.seg.start,
		}),
	}));
}
