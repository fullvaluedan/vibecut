/**
 * Deterministic non-speech noise-fragment detector.
 *
 * Every other detector needs transcript TEXT (duplicate words, fillers, dead-air
 * hesitations, take repeats) and `dead-air`/silence-removal only cut LOW-energy
 * time. So a brief HIGH-energy blip with NO transcript words — a bump, a
 * breath-pop, a chair creak, room noise between lines — is invisible to every
 * pass AND to the LLM (it has no text to reason about), and survives the cut.
 *
 * This guard scans the GAPS around the transcript (lead-in, between segments,
 * tail) — spans that by construction contain no words — and flags a SHORT one
 * whose mean energy is loud relative to the file's speech. Pure + wasm-free →
 * unit-tested. Review-gated like every Director cut (flagged, never auto-applied).
 *
 * Conservative by design: only SHORT gaps are flagged (a longer un-transcribed
 * sound could be intentional SFX / speech Whisper missed — left to the LLM), and
 * the loudness bar is a fraction of the MEDIAN speech segment so a quiet breath
 * or background hiss never trips it.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { ENERGY_WINDOW_SEC, meanEnergyOverRange } from "./audio-features";
import { stableCutId } from "./cut-utils";

/** A non-speech blip up to this long is a fragment worth flagging. Longer spans
 * (possible intentional SFX / un-transcribed speech) are left to the LLM. */
export const DEFAULT_MAX_FRAGMENT_SEC = 0.5;
/** Ignore gaps shorter than one energy window — the reading would bleed into the
 * neighbouring speech windows and isn't reliable. */
export const DEFAULT_MIN_FRAGMENT_SEC = ENERGY_WINDOW_SEC;
/** A gap reads as NOISE (not a quiet breath) at ≥ this fraction of the MEDIAN
 * speech-segment energy. */
export const DEFAULT_NOISE_ENERGY_RATIO = 0.5;

/** Minimal speech-span shape (a `SpeechFeatures` is structurally assignable). */
interface SpeechSpan {
	startSec: number;
	endSec: number;
	/** Mean RMS energy over the segment (file-relative scale). */
	energy: number;
}

function median(values: readonly number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Flag short, loud, word-less gaps around the transcript as noise fragments.
 *
 * @param features per-segment speech spans (for gap boundaries + the energy reference)
 * @param envelope the RMS energy envelope (one value per `windowSec`) the features came from
 */
export function detectNoiseFragmentCuts({
	features,
	envelope,
	windowSec = ENERGY_WINDOW_SEC,
	maxFragmentSec = DEFAULT_MAX_FRAGMENT_SEC,
	minFragmentSec = DEFAULT_MIN_FRAGMENT_SEC,
	energyRatio = DEFAULT_NOISE_ENERGY_RATIO,
}: {
	features: readonly SpeechSpan[];
	envelope: readonly number[];
	windowSec?: number;
	maxFragmentSec?: number;
	minFragmentSec?: number;
	energyRatio?: number;
}): DirectorOp[] {
	if (envelope.length === 0) {
		return [];
	}
	const spans = features
		.filter((f) => f.endSec > f.startSec)
		.sort((a, b) => a.startSec - b.startSec);
	// A noise gap is judged "loud" relative to speech, so a speech reference is
	// required; with no transcribed speech there is nothing to compare against.
	const speechEnergies = spans.map((s) => s.energy).filter((e) => e > 0);
	if (speechEnergies.length === 0) {
		return [];
	}
	const threshold = median(speechEnergies) * energyRatio;
	if (threshold <= 0) {
		return [];
	}

	// The audio's own length bounds the tail gap (no `totalSec` needed).
	const audioEndSec = envelope.length * windowSec;

	// Candidate word-less gaps: lead-in, each inter-segment gap, the tail.
	const gaps: Array<{ startSec: number; endSec: number }> = [
		{ startSec: 0, endSec: spans[0].startSec },
	];
	for (let i = 0; i < spans.length - 1; i++) {
		gaps.push({ startSec: spans[i].endSec, endSec: spans[i + 1].startSec });
	}
	gaps.push({ startSec: spans[spans.length - 1].endSec, endSec: audioEndSec });

	const ops: DirectorOp[] = [];
	for (const gap of gaps) {
		const start = Math.max(0, gap.startSec);
		const end = Math.min(audioEndSec, gap.endSec);
		const dur = end - start;
		if (dur < minFragmentSec || dur > maxFragmentSec) {
			continue;
		}
		const energy = meanEnergyOverRange({ envelope, windowSec, startSec: start, endSec: end });
		if (energy < threshold) {
			continue;
		}
		ops.push({
			id: `noise-${stableCutId(`${start.toFixed(3)}:${end.toFixed(3)}`)}`,
			op: "cut",
			startSec: start,
			endSec: end,
			reason: `Non-speech noise (${dur.toFixed(2)}s, no words)`,
			// Heuristic — keep confidence modest so it's easy to reject in review.
			confidence: 0.6,
			category: "noise",
		});
	}
	return ops;
}
