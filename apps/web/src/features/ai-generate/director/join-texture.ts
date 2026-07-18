/**
 * Join-texture layer (round 12 U1, R1/KTD1-KTD3). Every detector and LLM pass
 * judges its own cuts in isolation; nothing upstream ever reads the ASSEMBLED
 * result. This layer does: it runs at the END of `buildDirectorProposals` over
 * the FINAL merged operation list, pairs adjacent default-accepted removal
 * spans, and repairs the texture of each join between them.
 *
 * Two cases per adjacent pair (both neighbors must be default-accepted - an
 * opt-in neighbor is a review question, not a cut, so its gap is not a join):
 *
 * - A WORDLESS gap up to SILENT_SLIVER_MAX_SEC is a splice sliver, not a pause
 *   (the census measured 0.05-0.06s artifacts; real breathing pauses are
 *   pacing's job). Swallowing it moves zero transcript words, so essLost and
 *   match cannot shift by construction: it ships AUTO (KTD3).
 * - A kept run of 1..FRAGMENT_MAX_WORDS words is a stranded fragment ("so..."
 *   marooned between two cuts). The census was decisive that these are NOT
 *   auto-safe: Dan cut 15 of 18 but deliberately kept 3, and no deterministic
 *   signal separates the classes. The row is OFFERED (defaultAccept: false),
 *   quoting the stranded text; judgment belongs to the final-read pass (U2)
 *   or Dan (KTD2).
 *
 * Pure + wasm-free -> bun-testable. Overlapping/touching input spans are merged
 * before pairing so one covered region reads as ONE cut side and abutting cuts
 * never mint a zero-width join.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { isMidpointContained, stableCutId, type WordTiming } from "./cut-utils";

/** A wordless gap between two accepted cuts at/below this is a splice sliver,
 * swallowed AUTO (KTD3). Above it, a wordless gap is a real pause and stays. */
export const SILENT_SLIVER_MAX_SEC = 0.5;

/** A kept run of at most this many words between two accepted cuts is offered
 * for swallowing; longer runs are real kept content and are never flagged. */
export const FRAGMENT_MAX_WORDS = 4;

/**
 * Detect join-texture repairs over the FINAL merged op list: AUTO cuts for
 * wordless slivers between adjacent default-accepted removals, OFFERED cuts
 * for short stranded word fragments. Returns ONLY the new `join` ops; the
 * caller appends them to the operation list.
 */
export function detectJoinTextureCuts({
	ops,
	words,
}: {
	/** The final merged operation list (post-snap/refine/justify). */
	ops: readonly DirectorOp[];
	/** Transcript words (timeline seconds); kept-word counting is by midpoint. */
	words: readonly WordTiming[];
}): DirectorOp[] {
	// Default-accepted removal spans only (R1): cut/take_select with
	// defaultAccept absent or true. Opt-in rows are excluded entirely.
	const spans = ops
		.filter(
			(op) =>
				(op.op === "cut" || op.op === "take_select") &&
				op.defaultAccept !== false,
		)
		.map((op) => ({ startSec: op.startSec, endSec: op.endSec }))
		.sort((a, b) => a.startSec - b.startSec);

	// Merge overlapping/touching spans so pairing sees contiguous removed
	// regions, not individual ops (two ops sharing an edge have no gap).
	const merged: { startSec: number; endSec: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, span.endSec);
		} else {
			merged.push({ ...span });
		}
	}

	const joins: DirectorOp[] = [];
	for (let i = 0; i + 1 < merged.length; i++) {
		const gapStart = merged[i].endSec;
		const gapEnd = merged[i + 1].startSec;
		const gapSec = gapEnd - gapStart;
		if (!(gapSec > 0)) continue;
		const kept = words.filter((w) =>
			isMidpointContained({
				spanStart: w.start,
				spanEnd: w.end,
				containerStart: gapStart,
				containerEnd: gapEnd,
			}),
		);
		if (kept.length === 0) {
			if (gapSec <= SILENT_SLIVER_MAX_SEC) {
				joins.push({
					id: `join-${stableCutId(`sliver:${gapStart.toFixed(3)}:${gapEnd.toFixed(3)}`)}`,
					op: "cut",
					startSec: gapStart,
					endSec: gapEnd,
					reason: `Silent sliver (${gapSec.toFixed(2)}s) between two cuts - swallowed for a clean join`,
					confidence: 0.6,
					category: "join",
				});
			}
		} else if (kept.length <= FRAGMENT_MAX_WORDS) {
			const text = kept.map((w) => w.text.trim()).join(" ");
			joins.push({
				id: `join-${stableCutId(`fragment:${text}:${gapStart.toFixed(3)}:${gapEnd.toFixed(3)}`)}`,
				op: "cut",
				startSec: gapStart,
				endSec: gapEnd,
				reason: `Stranded between two cuts: "${text}" - swallow it?`,
				confidence: 0.6,
				category: "join",
				// Never AUTO for word-bearing fragments (KTD2). Explicit `false`,
				// matching the redundancy-apply convention (absent = accepted).
				defaultAccept: false,
			});
		}
	}
	return joins;
}
