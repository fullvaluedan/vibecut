/**
 * Deterministic emphasis/anchor score for the Director's keep-side (U1).
 *
 * HONEST FRAMING (KTD1): this is an *emphasis/anchor* signal, not an importance
 * oracle. It reliably finds where the speaker leaned in (loudness), spoke with
 * confident delivery (steady rate, no filler), and packed content (content-word
 * density + thesis markers) — and it rules OUT dead/filler spans. It does NOT
 * recognize taste (a joke landing, a surprising claim, a quiet pivotal line); a
 * loud incidentally-dense aside can outscore a quiet thesis. That ceiling is why
 * the LLM keep-pass is the PRIMARY channel for Highlight selection and why the
 * deterministic floor must beat random on a flat-delivery sample before Highlight
 * ships beyond suggest-mode (R9). Pure + wasm-free so it is bun-testable; reuses
 * `contentTokens` and the per-segment `SpeechFeatures`.
 */

import { contentTokens } from "./text-similarity";
import type { SpeechFeatures } from "./types";

/** Blend weights (sum to 1); lexical is weighted highest to content-gate loudness. */
const W_EMPHASIS = 0.35;
const W_RATE = 0.25;
const W_LEXICAL = 0.4;

/** Speaking-rate band (wpm): confidence ramps up to LOW, holds to HIGH, ramps down. */
const RATE_FLOOR = 60;
const RATE_LOW = 110;
const RATE_HIGH = 180;
const RATE_CEIL = 260;
/** A filler/false-start segment keeps only this fraction of its rate confidence. */
const FILLER_KEEP = 0.4;

/** Content words/sec at or above which lexical density saturates to 1. */
const DENSITY_CAP = 2.5;
/** Additive salience bonus (capped) when a thesis-marker phrase is present. */
const THESIS_BONUS = 0.3;
/**
 * Bounded thesis-marker phrase set (the cap IS this array). High-precision
 * signposting; intentionally small — expanding it is gated on the R9 validation.
 */
const THESIS_MARKERS: readonly string[] = [
	"the key thing is",
	"the point is",
	"what matters",
	"the takeaway",
	"most important",
	"the trick is",
	"here's the thing",
];

/** A transcript segment in timeline seconds (the shape the signal table uses). */
export interface ImportanceSegment {
	start: number;
	end: number;
	text: string;
}

function clamp01(n: number): number {
	return Math.max(0, Math.min(1, n));
}

/** Rate confidence in [0,1]: a trapezoid peaking across the healthy wpm band. */
function rateConfidence(wpm: number): number {
	if (wpm <= RATE_FLOOR || wpm >= RATE_CEIL) return 0;
	if (wpm < RATE_LOW) return (wpm - RATE_FLOOR) / (RATE_LOW - RATE_FLOOR);
	if (wpm > RATE_HIGH) return (RATE_CEIL - wpm) / (RATE_CEIL - RATE_HIGH);
	return 1;
}

/** Lexical salience in [0,1]: content-word density (capped) + a thesis-marker bonus. */
function lexicalSalience({ text, durationSec }: { text: string; durationSec: number }): number {
	if (durationSec <= 0) return 0;
	const density = contentTokens(text).size / durationSec;
	let salience = clamp01(density / DENSITY_CAP);
	const lower = ` ${text.toLowerCase()} `;
	if (THESIS_MARKERS.some((m) => lower.includes(m))) {
		salience = clamp01(salience + THESIS_BONUS);
	}
	return salience;
}

/**
 * Score each segment in [0,1] by blending emphasis, rate confidence, and lexical
 * salience. `features` is parallel to `segments` (one per segment); a missing
 * feature row degrades to lexical-only for that segment. Returns one score per
 * segment, in segment order.
 */
export function scoreImportance({
	segments,
	features,
}: {
	segments: readonly ImportanceSegment[];
	features: readonly SpeechFeatures[];
}): number[] {
	return segments.map((seg, i) => {
		const durationSec = seg.end - seg.start;
		if (durationSec <= 0) return 0;

		const f = features[i];
		const emphasis = f ? clamp01(f.loudnessRelative) : 0;
		const rate = f
			? rateConfidence(f.wpm) * (f.fillerCandidate ? FILLER_KEEP : 1)
			: 0;
		const lexical = lexicalSalience({ text: seg.text, durationSec });

		return clamp01(W_EMPHASIS * emphasis + W_RATE * rate + W_LEXICAL * lexical);
	});
}
