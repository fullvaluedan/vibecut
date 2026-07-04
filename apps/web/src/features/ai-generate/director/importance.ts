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

/** A span ≥ this score is eligible for normal-cut protection. */
export const PROTECT_FLOOR = 0.6;
/** Never protect more than this many spans (the cut must still do work). */
export const MAX_PROTECTED_SPANS = 8;
/** ...nor more than this fraction of the timeline (KTD2 — conservative = LESS protection). */
export const MAX_PROTECTED_FRACTION = 0.4;

/** A timeline span to protect from removal (seconds). */
export interface ProtectedSpan {
	startSec: number;
	endSec: number;
}

/**
 * Pick the spans the normal Director must not cut: above-floor segments, ranked by
 * score, CAPPED at both a span count and a fraction of the timeline (KTD2). The cap
 * is essential — without it, dense confident footage (exactly what the score rewards)
 * protects most segments and the cut does nothing. Returns timeline-ordered spans;
 * the caller unions them with the take-cluster keepers and passes to the merge.
 */
export function selectProtectedSpans({
	segments,
	importance,
	options,
}: {
	segments: readonly { start: number; end: number }[];
	importance: readonly number[];
	options?: { protectFloor?: number; maxSpans?: number; maxFraction?: number };
}): ProtectedSpan[] {
	const floor = options?.protectFloor ?? PROTECT_FLOOR;
	const maxSpans = options?.maxSpans ?? MAX_PROTECTED_SPANS;
	const maxFraction = options?.maxFraction ?? MAX_PROTECTED_FRACTION;

	const total = segments.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);
	const candidates = segments
		.map((s, i) => ({ start: s.start, end: s.end, dur: Math.max(0, s.end - s.start), score: importance[i] ?? 0 }))
		.filter((c) => c.score >= floor && c.dur > 0)
		.sort((a, b) => b.score - a.score || a.start - b.start);

	const out: ProtectedSpan[] = [];
	let acc = 0;
	for (const c of candidates) {
		if (out.length >= maxSpans) break;
		// Fraction cap — but always allow at least one protected span.
		if (out.length >= 1 && total > 0 && acc + c.dur > maxFraction * total) break;
		out.push({ startSec: c.start, endSec: c.end });
		acc += c.dur;
	}
	return out.sort((a, b) => a.startSec - b.startSec);
}
