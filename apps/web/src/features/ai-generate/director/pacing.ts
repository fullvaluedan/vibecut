/**
 * Deterministic pacing detector (Round-2 U3). Silence-removal already trims
 * silence above a fixed threshold, but the remaining inter-sentence pauses still
 * drag. This proposes cutting the EXCESS dead air — shortening a gap down to a
 * target, not removing it entirely — as reviewable cuts. Pure + wasm-free; the
 * cuts are review-flagged with low confidence (pacing is subjective).
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { stableCutId, stripWordsFromRemoval, type WordTiming } from "./cut-utils";

/** A transcript segment with timeline-relative timing (seconds). */
export interface PacingSegment {
	start: number;
	end: number;
}

/** Below this gap there's nothing worth tightening. */
const DEFAULT_MIN_GAP_SECONDS = 0.8;
/** Leave this much pause after the cut (keeps a natural beat). */
const DEFAULT_TARGET_GAP_SECONDS = 0.4;

/**
 * Propose a cut of the excess pause for each inter-segment gap longer than
 * `minGapSeconds`, leaving `targetGapSeconds` of breathing room. Each op carries
 * `category: "pacing"`.
 */
export function detectPacingCuts({
	segments,
	words = [],
	minGapSeconds = DEFAULT_MIN_GAP_SECONDS,
	targetGapSeconds = DEFAULT_TARGET_GAP_SECONDS,
}: {
	segments: readonly PacingSegment[];
	/** Word timings for the U5 word-guard: a pacing span containing a word
	 * midpoint is split into word-free sub-spans at emission. Segment gaps
	 * SHOULD be word-free, but segment and word boundaries can disagree
	 * (transcription drift), and a pacing cut must never ship speech. */
	words?: readonly WordTiming[];
	minGapSeconds?: number;
	targetGapSeconds?: number;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (let i = 1; i < segments.length; i++) {
		const prevEnd = segments[i - 1].end;
		const gap = segments[i].start - prevEnd;
		if (gap <= minGapSeconds) continue;
		const cutStart = prevEnd + targetGapSeconds;
		const cutEnd = segments[i].start;
		if (cutEnd - cutStart <= 0) continue;
		const op: DirectorOp = {
			id: `pac-${stableCutId(`${cutStart.toFixed(3)}:${cutEnd.toFixed(3)}`)}`,
			op: "cut",
			startSec: cutStart,
			endSec: cutEnd,
			reason: `Long pause (${gap.toFixed(1)}s) — tighten`,
			confidence: 0.5,
			category: "pacing",
		};
		ops.push(...stripWordsFromRemoval({ op, words }));
	}
	return ops;
}
