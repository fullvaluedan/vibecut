/**
 * Deterministic adjacent-duplicate-word detector (#1). The LLM planner reasons
 * at the SEGMENT level and can't see a doubled word inside a segment (e.g. a
 * stumbled "now now"); this scans WORD-level transcript timing and emits a cut
 * over the SECOND of two adjacent equal words. Pure + wasm-free so it's unit
 * tested; the ops it returns are merged into the Director plan and shown in the
 * Review modal (flagged, not auto-applied).
 */

import type { DirectorOp } from "@framecut/hf-bridge";

/** One transcript word with timeline-relative timing (seconds). */
export interface DupWord {
	text: string;
	start: number;
	end: number;
}

/**
 * Words whose doubling is usually deliberate (emphasis / idiom), so flagging a
 * cut would be wrong more often than right. Kept conservative — the modal still
 * lets the user accept a real stumble we skipped.
 */
const INTENTIONAL_DOUBLES = new Set([
	"no",
	"yeah",
	"ha",
	"ho",
	"bye",
	"night",
	"very",
	"really",
	"so",
	"go",
	"hey",
	"ok",
	"okay",
	"knock",
	"woah",
	"whoa",
	"boom",
]);

/**
 * Two occurrences further apart than this read as a pause, not a stumble. Real
 * stumbled repeats carry a re-articulation pause, so this is generous; the cuts
 * are review-flagged, not auto-applied.
 */
const DEFAULT_MAX_GAP_SECONDS = 1.0;
/** Look back this many words for the repeat, so one breath/filler between the
 * two equal words doesn't hide the duplicate. */
const MAX_LOOKBACK = 2;
/** Interstitial tokens we'll step over when looking back for the repeat. */
const FILLERS = new Set(["uh", "um", "er", "ah", "eh", "hmm", "mm", "mhm"]);

/** Lowercase + strip surrounding punctuation; keep inner apostrophes/digits. */
function normalizeWord(text: string): string {
	return text
		.toLowerCase()
		.replace(/^[^a-z0-9']+/, "")
		.replace(/[^a-z0-9']+$/, "");
}

/** djb2 → base36. Local copy so this module stays free of planner internals. */
function dupOpId(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return `dup-${(hash >>> 0).toString(36)}`;
}

/**
 * Scan adjacent words for an immediate repeat of the same token and return a
 * `cut` op over the second occurrence (keeping the first, clean read). Triples
 * ("now now now") yield a cut per extra occurrence, so one survives.
 */
export function detectDuplicateWordCuts({
	words,
	maxGapSeconds = DEFAULT_MAX_GAP_SECONDS,
}: {
	words: DupWord[];
	maxGapSeconds?: number;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (let i = 1; i < words.length; i++) {
		const cur = words[i];
		const b = normalizeWord(cur.text);
		// Single-letter tokens ("a a", "I I") are too noisy; allow-listed doubles
		// (no/yeah/very…) are usually deliberate.
		if (!b || b.length < 2 || INTENTIONAL_DOUBLES.has(b)) continue;
		if (cur.end <= cur.start) continue;

		// Look back for the same token, stepping over at most one breath/filler —
		// real stumbles often have a re-articulation pause or an interstitial that
		// whisper tokenizes, so strict i-1 adjacency misses them.
		let matchIndex = -1;
		for (let j = i - 1; j >= Math.max(0, i - MAX_LOOKBACK); j--) {
			const token = normalizeWord(words[j].text);
			if (token === b) {
				matchIndex = j;
				break;
			}
			if (token !== "" && !FILLERS.has(token)) break;
		}
		if (matchIndex < 0) continue;

		const gap = cur.start - words[matchIndex].end;
		if (gap < 0 || gap > maxGapSeconds) continue;

		ops.push({
			id: dupOpId(`${b}:${cur.start.toFixed(3)}:${cur.end.toFixed(3)}`),
			op: "cut",
			startSec: cur.start,
			endSec: cur.end,
			reason: `Repeated word "${cur.text.trim()}" — likely a stumble`,
			// Wider gaps are less certain — still flag, but lower confidence.
			confidence: gap > 0.5 ? 0.6 : 0.7,
		});
	}
	return ops;
}

/**
 * Merge deterministic duplicate-word cuts into a planner's ops, dropping any
 * that overlap an existing removal (the LLM already cut that span). Returns the
 * combined op list in time order.
 */
export function mergeDuplicateCuts({
	planOps,
	dupOps,
}: {
	planOps: DirectorOp[];
	dupOps: DirectorOp[];
}): DirectorOp[] {
	const removals = planOps.filter(
		(op) => op.op === "cut" || op.op === "take_select",
	);
	const overlaps = (op: DirectorOp): boolean =>
		removals.some((r) => op.startSec < r.endSec && r.startSec < op.endSec);
	const fresh = dupOps.filter((op) => !overlaps(op));
	return [...planOps, ...fresh].sort((a, b) => a.startSec - b.startSec);
}
