/**
 * Virtual second-pass convergence loop (2P-U3, KTD3/KTD4).
 *
 * Compression reveals adjacency: two verbatim takes 60s apart are invisible to the
 * repeat detectors until the material between them is cut, and only THEN do they sit
 * close enough to match. Pass 1 analyzes only the ORIGINAL timeline, so it misses
 * these. This re-analyzes the Director's own compressed output: it virtually applies
 * the accepted cuts to the transcript (no re-transcription, no LLM re-runs), re-runs
 * the DETERMINISTIC detectors on the shortened words/segments, maps every new finding
 * back to ORIGINAL coordinates, dedups it against the existing ops, and folds it into
 * the SAME review with the SAME accept defaults as pass 1. Repeats to convergence,
 * capped at 3 passes total (pass 1 is the caller's existing run; this loop adds passes
 * 2 and 3).
 *
 * PURE + wasm-free -> bun-testable. Touches neither the timeline nor the persisted
 * transcript cache: it only computes ops. Apply still happens once, later, via the
 * review accept, through the caller's snap/coalesce chain.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { remapTranscriptTimestamps } from "@/features/transcription/remap-transcript-timestamps";
import {
	mergeDetectedCuts,
	stableCutId,
	type KeeperSpan,
	type WordTiming,
} from "./cut-utils";
import { detectDuplicateWordCuts } from "./duplicate-words";
import { detectDeadAirCuts } from "./dead-air";
import { detectFillerCuts } from "./filler-words";
import { detectPacingCuts } from "./pacing";
import { detectPhraseRepeatCuts } from "./phrase-repeat";
import { detectSegmentRepeatCuts } from "./segment-repeat";
import { lexicalBackstopDefaultAccept } from "./redundancy-apply";

/** A transcript segment with timeline-relative timing (seconds). */
export interface SecondPassSegment {
	start: number;
	end: number;
	text: string;
}

/** A disjoint removal span in seconds. */
export interface RemovalSpan {
	startSec: number;
	endSec: number;
}

const isRemoval = (op: DirectorOp): boolean =>
	op.op === "cut" || op.op === "take_select";

/**
 * The DEFAULT-ACCEPTED removal spans from an op set, sorted and unioned into disjoint
 * ranges. Only `cut`/`take_select` ops that start accepted (`defaultAccept !== false`)
 * are applied virtually - an opt-in row the user hasn't checked isn't part of the
 * compressed timeline the second pass reasons over. Overlapping/touching spans are
 * merged so the forward/inverse remap math sees clean disjoint ranges.
 */
export function acceptedRemovalSpans(ops: readonly DirectorOp[]): RemovalSpan[] {
	const spans = ops
		.filter((op) => isRemoval(op) && op.defaultAccept !== false)
		.map((op) => ({ startSec: op.startSec, endSec: op.endSec }))
		.filter((s) => s.endSec > s.startSec)
		.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
	if (spans.length === 0) return [];

	const merged: RemovalSpan[] = [{ ...spans[0] }];
	for (let i = 1; i < spans.length; i++) {
		const prev = merged[merged.length - 1];
		const cur = spans[i];
		if (cur.startSec <= prev.endSec) {
			prev.endSec = Math.max(prev.endSec, cur.endSec);
		} else {
			merged.push({ ...cur });
		}
	}
	return merged;
}

/**
 * Forward map (ORIGINAL -> COMPRESSED) for a point in a RETAINED region: subtract the
 * total duration of every removal that ended at or before it. Undefined for a point
 * strictly inside a removal (the caller never maps those). Removals must be the sorted
 * disjoint output of `acceptedRemovalSpans`.
 */
export function forwardRemapTime(
	originalSec: number,
	removals: readonly RemovalSpan[],
): number {
	let removed = 0;
	for (const r of removals) {
		if (r.endSec <= originalSec) removed += r.endSec - r.startSec;
	}
	return originalSec - removed;
}

/**
 * Inverse map (COMPRESSED -> ORIGINAL): add back the duration of every removal whose
 * COMPRESSED start position (`r.startSec` minus the removal duration accumulated before
 * it) is before `remappedSec`. Because the removals are disjoint sorted ranges, the
 * forward map (remove) and this inverse are exact for any point in a retained region:
 * `inverseRemapTime(forwardRemapTime(t)) === t`.
 *
 * A removal's collapse point is AMBIGUOUS - it is both the end of the content before
 * the cut and the start of the content after it. `edge` breaks the tie so a cut span
 * maps back cleanly: a cut's `start` (`edge: "start"`) belongs to the content AFTER the
 * collapse (maps to the later original), its `end` (`edge: "end"`) to the content
 * BEFORE it (the earlier original). For a point strictly interior to a retained region
 * the two agree, so the round-trip property holds regardless of `edge`.
 */
export function inverseRemapTime(
	remappedSec: number,
	removals: readonly RemovalSpan[],
	edge: "start" | "end" = "start",
): number {
	let removed = 0;
	for (const r of removals) {
		const collapse = r.startSec - removed; // this removal's COMPRESSED position
		const past = edge === "start" ? remappedSec >= collapse : remappedSec > collapse;
		if (past) removed += r.endSec - r.startSec;
	}
	return remappedSec + removed;
}

/** Midpoint of an item lies inside a removal -> the item is gone from the compressed
 * transcript. Midpoint (not any-overlap) so a word snapped flush to a cut edge is not
 * spuriously dropped; removals are snapped to troughs between words, so words don't
 * straddle in practice. */
function isRemovedItem(
	item: { start: number; end: number },
	removals: readonly RemovalSpan[],
): boolean {
	const mid = (item.start + item.end) / 2;
	return removals.some((r) => r.startSec <= mid && mid < r.endSec);
}

/**
 * Build the COMPRESSED words + segments: drop every item inside an accepted removal,
 * then shift the survivors left through the removals using the shipped
 * `remapTranscriptTimestamps` helper. Applied removal-by-removal RIGHT-TO-LEFT so each
 * removal's `deletedEndSec`/`removedDurationSec` stay in the item's current coordinate
 * space (a removal to the right never shifts a coordinate to its left), which composes
 * to exactly the cumulative-shift forward map - the same semantics the shipped
 * delete-then-remap-sequence test asserts for sequential live deletes.
 */
export function buildRemappedTranscript({
	words,
	segments,
	removals,
}: {
	words: readonly WordTiming[];
	segments: readonly SecondPassSegment[];
	removals: readonly RemovalSpan[];
}): { words: WordTiming[]; segments: SecondPassSegment[] } {
	let rw = words.filter((w) => !isRemovedItem(w, removals));
	let rs = segments.filter((s) => !isRemovedItem(s, removals));
	for (let i = removals.length - 1; i >= 0; i--) {
		const r = removals[i];
		const removedDurationSec = r.endSec - r.startSec;
		rw = remapTranscriptTimestamps({
			items: rw,
			deletedEndSec: r.endSec,
			removedDurationSec,
		});
		rs = remapTranscriptTimestamps({
			items: rs,
			deletedEndSec: r.endSec,
			removedDurationSec,
		});
	}
	return { words: rw, segments: rs };
}

/**
 * Run the six DETERMINISTIC transcript detectors on a (compressed) transcript and
 * apply the SAME accept defaults pass 1 uses: word-level cleanup (duplicate / dead-air
 * / filler / pacing) and verbatim phrase-repeat auto-accept; the softer segment-repeat
 * backstop is opt-in when the LLM redundancy pass ran and accepted only on its route-
 * error fallback (`lexicalBackstopDefaultAccept`). No VAD / noise / tiny-clip / LLM.
 */
function detectOnTranscript({
	words,
	segments,
	redundancyRan,
}: {
	words: readonly WordTiming[];
	segments: readonly SecondPassSegment[];
	redundancyRan: boolean;
}): DirectorOp[] {
	const wordCuts = [
		...detectDuplicateWordCuts({ words: [...words] }),
		...detectDeadAirCuts({ words }),
		...detectFillerCuts({ words: [...words] }),
		...detectPacingCuts({ segments }),
	];
	const phraseRepeatCuts = detectPhraseRepeatCuts({ words });
	// Drop segment-repeat cuts overlapping a word-level / phrase-repeat cut so the
	// layers don't double up (mirrors run-director's pass-1 filter).
	const segmentRepeatCuts = detectSegmentRepeatCuts({ segments }).filter(
		(op) =>
			![...wordCuts, ...phraseRepeatCuts].some(
				(w) => w.startSec < op.endSec && op.startSec < w.endSec,
			),
	);
	const withBackstopAccept = (op: DirectorOp, verbatim: boolean): DirectorOp =>
		lexicalBackstopDefaultAccept({ verbatim, redundancyRan })
			? op
			: { ...op, defaultAccept: false };
	return [
		...wordCuts,
		...phraseRepeatCuts.map((op) => withBackstopAccept(op, true)),
		...segmentRepeatCuts.map((op) => withBackstopAccept(op, false)),
	];
}

export interface SecondPassResult {
	/** New cut ops in ORIGINAL coordinates, deduped + keeper-protected, ready to fold
	 * into the pass-1 op set through the caller's snap/coalesce chain. */
	extraOps: DirectorOp[];
	/** Total passes RUN including pass 1 (2 = one extra pass, 3 = the cap was hit). */
	passesRun: number;
	/** How many new ops each extra pass surfaced, for the toast/log. */
	perPass: number[];
}

/**
 * The convergence loop. From the merged pass-1 ops, repeatedly: apply the accepted
 * removals to the transcript, re-detect on the compressed result, inverse-map each new
 * cut to original coordinates, dedup + keeper-protect it against ALL prior ops, and
 * fold it in - while new ops keep appearing, capped at `maxPasses` total (default 3).
 * Pass 1 is the caller's existing run, so the loop body runs at most `maxPasses - 1`
 * times (passes 2 and 3). Deterministic, so it always terminates; the dedup guarantees
 * each pass's op set is a strict superset only while genuinely-new cuts exist.
 */
export function runSecondPass({
	ops,
	words,
	segments,
	keepers = [],
	redundancyRan,
	maxPasses = 3,
}: {
	ops: readonly DirectorOp[];
	words: readonly WordTiming[];
	segments: readonly SecondPassSegment[];
	keepers?: readonly KeeperSpan[];
	redundancyRan: boolean;
	maxPasses?: number;
}): SecondPassResult {
	const extraOps: DirectorOp[] = [];
	const perPass: number[] = [];
	let allOps: DirectorOp[] = ops.filter((op) => op.op !== "keep");
	let passesRun = 1;

	while (passesRun < maxPasses) {
		const removals = acceptedRemovalSpans(allOps);
		passesRun++;
		if (removals.length === 0) {
			perPass.push(0);
			break;
		}

		const { words: rw, segments: rs } = buildRemappedTranscript({
			words,
			segments,
			removals,
		});
		// Re-detect in COMPRESSED coords, then inverse-map each edge back to ORIGINAL
		// and give it a fresh `sp-` id (encoding the original span) so it can never
		// collide with a pass-1 id and the dedup below can identify what survived.
		const remapped = detectOnTranscript({ words: rw, segments: rs, redundancyRan });
		const originalCoordOps: DirectorOp[] = remapped.map((op) => {
			const startSec = inverseRemapTime(op.startSec, removals, "start");
			const endSec = inverseRemapTime(op.endSec, removals, "end");
			return {
				...op,
				startSec,
				endSec,
				id: `sp-${stableCutId(`${op.category}:${startSec.toFixed(3)}:${endSec.toFixed(3)}`)}`,
			};
		});

		const existingIds = new Set(allOps.map((op) => op.id));
		// Same dedup + keeper protection the pass-1 merge uses: a new op overlapping a
		// surviving removal or covering a keeper is dropped. The fresh survivors are the
		// ones in the result the prior op set didn't already have.
		const merged = mergeDetectedCuts({
			planOps: allOps,
			extraOps: originalCoordOps,
			keepers,
		}).filter((op) => op.op !== "keep");
		const fresh = merged.filter((op) => !existingIds.has(op.id));
		perPass.push(fresh.length);
		if (fresh.length === 0) break;

		extraOps.push(...fresh);
		allOps = merged; // grow the op set so the next pass compresses further + dedups
	}

	return { extraOps, passesRun, perPass };
}
