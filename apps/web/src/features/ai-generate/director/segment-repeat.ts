/**
 * Deterministic CONSECUTIVE near-identical SEGMENT detector.
 *
 * The word-level `phrase-repeat` detector needs per-word timing (Whisper cross-
 * attention), which the default model can't emit — so it goes dark and back-to-
 * back restatements ("said the same line three times at the start") survive. This
 * backstop works purely on SEGMENT text + timing: a run of consecutive segments
 * whose text is near-identical is a restart loop; cut all but the LAST (keep the
 * cleanest attempt, like a retake). Pure + wasm-free → bun-testable; the ops merge
 * into the plan and show in the Review modal (flagged, not auto-applied).
 *
 * Consecutive-only by design — a far-apart restatement reads as a deliberate
 * callback and is the take-clusterer's / LLM's job, not this backstop's.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { stableCutId } from "./cut-utils";
import { HIGH_SIMILAR, similarity, tokenize } from "./text-similarity";

/** A transcript segment with timeline-relative timing (seconds). */
export interface RepeatSegment {
	start: number;
	end: number;
	text: string;
}

/** Min content tokens for a segment to anchor a run — shorter is noise ("yeah"). */
const DEFAULT_MIN_TOKENS = 3;
/** A repeat farther than this from the previous take reads as a callback, not a restart. */
const DEFAULT_WINDOW_SECONDS = 45;

/**
 * Find runs of consecutive near-identical segments and cut every member EXCEPT
 * the last. A run of N back-to-back takes yields N-1 cuts, so the final (usually
 * cleanest) attempt survives. Each cut is `category: "repeat"` so the review row
 * reads "Repeat" and rejecting it means "keep the duplicate".
 */
export function detectSegmentRepeatCuts({
	segments,
	minTokens = DEFAULT_MIN_TOKENS,
	windowSeconds = DEFAULT_WINDOW_SECONDS,
	threshold = HIGH_SIMILAR,
}: {
	segments: readonly RepeatSegment[];
	minTokens?: number;
	windowSeconds?: number;
	threshold?: number;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	let i = 0;
	while (i < segments.length) {
		const anchor = segments[i];
		// Only anchor on a real phrase so short interjections aren't cut.
		if (tokenize(anchor.text).length < minTokens) {
			i++;
			continue;
		}
		// Extend a run of consecutive segments near-identical to the anchor and
		// within the time window of the previous run member.
		let runEnd = i;
		while (runEnd + 1 < segments.length) {
			const next = segments[runEnd + 1];
			if (next.start - segments[runEnd].end > windowSeconds) break;
			if (similarity({ a: anchor.text, b: next.text }) < threshold) break;
			runEnd++;
		}
		if (runEnd > i) {
			const takeCount = runEnd - i + 1;
			// Cut every member except the last — keep the cleanest/last attempt.
			for (let k = i; k < runEnd; k++) {
				const seg = segments[k];
				const trimmed = seg.text.trim();
				const preview = trimmed.slice(0, 48);
				ops.push({
					id: `segrep-${stableCutId(`${seg.start.toFixed(3)}:${seg.end.toFixed(3)}`)}`,
					op: "cut",
					startSec: seg.start,
					endSec: seg.end,
					reason: `Repeated line "${preview}${trimmed.length > 48 ? "…" : ""}" — kept the last of ${takeCount} back-to-back takes`,
					confidence: 0.7,
					category: "repeat",
				});
			}
			i = runEnd + 1;
		} else {
			i++;
		}
	}
	return ops;
}
