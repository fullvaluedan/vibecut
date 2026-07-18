/**
 * No-unnecessary-cuts guard (2P-U5, R9). A sub-floor removal that splices two
 * content words in CONTINUOUS speech and carries no concrete removal reason
 * (filler / repeat / silence / dead-air / mistake / context) is a false-positive
 * cut: it fragments the timeline mid-sentence for nothing. This reverts exactly
 * those, keeping the footage; every other removal is left untouched.
 *
 * A removal is dropped only when ALL hold:
 *  - it is a plain `cut` (take_select / reorder are deliberate structure), AND
 *  - it is shorter than the floor (a real pause / mistake removal is longer), AND
 *  - its category names no concrete reason: only `pacing` (or an uncategorised cut
 *    with an empty reason) qualifies - filler / repeat / dead-air / etc. are
 *    justified and kept, AND
 *  - it sits in a sub-floor gap between two adjacent content words (continuous
 *    speech), NOT inside a real pause (which is a legitimate silence removal).
 *
 * Fail-open: with no word timings nothing is dropped (continuity is unprovable).
 * Pure + wasm-free -> bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import type { WordTiming } from "./cut-utils";
import { isContentWord } from "./content-word";

/** Categories that name a concrete removal reason - never reverted as unjustified. */
const JUSTIFIED_REMOVAL: ReadonlySet<string> = new Set([
	"filler",
	"duplicate",
	"repeat",
	"redundancy",
	"deadair",
	"noise",
	"context",
	"take",
	"vision",
	"reorder",
	// The OFFERED-only recall passes (rounds 3-4): their rows carry a concrete
	// reason and must reach review; without these entries a short trimmed
	// remainder in continuous speech was silently reverted before review.
	"retake",
	"structural",
	// Tagged trailing-speculation cuts (round 9): OFFERED-only like retake and
	// structural, and they must reach review rather than be silently reverted.
	"speculation",
]);

/** Whether an op carries a real reason to remove its span (so it is never reverted). */
function hasRealReason(op: DirectorOp): boolean {
	if (op.category !== undefined) return JUSTIFIED_REMOVAL.has(op.category);
	// Uncategorised (raw LLM) cut: justified as long as it carries a reason string.
	return op.reason.trim().length > 0;
}

/**
 * True when `[startSec, endSec)` sits in a sub-floor gap between the content word
 * that ends nearest before it and the content word that starts nearest after it,
 * with those two flanking words less than the floor apart - i.e. the cut splices
 * continuous speech rather than trimming a real pause. A real pause leaves the
 * flanking words a floor or more apart, so a silence removal is never flagged.
 */
function splicesContinuousSpeech({
	startSec,
	endSec,
	words,
	floorSec,
}: {
	startSec: number;
	endSec: number;
	words: readonly WordTiming[];
	floorSec: number;
}): boolean {
	let before: WordTiming | null = null; // content word ending latest at/before the cut end
	let after: WordTiming | null = null; // content word starting earliest at/after the cut start
	for (const w of words) {
		if (!isContentWord(w)) continue;
		if (w.end <= endSec && (before === null || w.end > before.end)) before = w;
		if (w.start >= startSec && (after === null || w.start < after.start)) after = w;
	}
	if (!before || !after) return false;
	return after.start - before.end < floorSec;
}

/**
 * Drop every unjustified sub-floor mid-continuous-speech cut, keeping its footage.
 * Returns a new op list; ops that survive are byte-identical (no rewrite).
 */
export function justifyCuts({
	ops,
	words,
	floorSec,
}: {
	ops: readonly DirectorOp[];
	words?: readonly WordTiming[];
	floorSec: number;
}): DirectorOp[] {
	if (!words || words.length === 0) return [...ops]; // fail-open: keep everything
	return ops.filter((op) => {
		if (op.op !== "cut") return true; // only plain cuts are candidates
		const widthSec = op.endSec - op.startSec;
		if (!(widthSec > 0) || widthSec >= floorSec) return true; // over floor: keep
		if (hasRealReason(op)) return true; // justified removal: keep
		return !splicesContinuousSpeech({
			startSec: op.startSec,
			endSec: op.endSec,
			words,
			floorSec,
		});
	});
}
