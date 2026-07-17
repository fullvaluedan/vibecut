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
import {
	removalCoversKeeper,
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
import { mergeSpans } from "./keep-select";

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
 * Minimum NEW footage (seconds) an overlapping pass-2 op must add to survive dedup.
 * At or above the surviving-clip floor (15 frames at 30fps): anything smaller would
 * be edge jitter from the remap round-trip re-finding an existing cut, not a new
 * finding; anything at/above it is a genuinely wider removal (a revealed repeat
 * containing pass-1 micro-cuts).
 */
const NEW_COVERAGE_FLOOR_SEC = 0.5;

/**
 * The DEFAULT-ACCEPTED removal spans from an op set, sorted and unioned into disjoint
 * ranges. Only `cut`/`take_select` ops that start accepted (`defaultAccept !== false`)
 * are applied virtually - an opt-in row the user hasn't checked isn't part of the
 * compressed timeline the second pass reasons over. Overlapping/touching spans are
 * merged so the forward/inverse remap math sees clean disjoint ranges.
 */
export function acceptedRemovalSpans(ops: readonly DirectorOp[]): RemovalSpan[] {
	return mergeSpans(
		ops
			.filter((op) => isRemoval(op) && op.defaultAccept !== false)
			.map((op) => ({ startSec: op.startSec, endSec: op.endSec })),
	);
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

/**
 * Drop the items inside `removals` and shift the survivors left, in ONE sorted sweep
 * (O(n + removals), one output array). Membership and shift use the SAME start-based
 * rule: an item whose start lies inside a removal is gone; a survivor shifts by the
 * total duration removed before its start. The old midpoint membership disagreed with
 * the start-based shift on words straddling a removal edge (the second pass runs
 * BEFORE energy snapping, so LLM/VAD/take_select edges land mid-word routinely),
 * leaving unshifted survivors that garbled the compressed order and inverse-mapped
 * detector findings onto the wrong footage. A survivor that overlaps one or more
 * removals in its interior has each overlap's duration SUBTRACTED from its end (X1),
 * so a segment holding an interior micro-cut keeps its tail instead of being
 * amputated at the first removal; the compressed items stay disjoint and sorted.
 */
function applyRemovalsToItems<T extends { start: number; end: number }>(
	items: readonly T[],
	removals: readonly RemovalSpan[],
): T[] {
	const sorted = [...items].sort((a, b) => a.start - b.start);
	const out: T[] = [];
	let ri = 0;
	let removedBefore = 0;
	for (const item of sorted) {
		while (ri < removals.length && removals[ri].endSec <= item.start) {
			removedBefore += removals[ri].endSec - removals[ri].startSec;
			ri++;
		}
		const next = removals[ri]; // first removal ending after this item starts
		if (next && item.start >= next.startSec) continue; // starts inside -> gone
		// Subtract EVERY removal overlapping the item's interior, not just clamp to
		// the first one. Clamping amputated a SEGMENT's whole tail whenever a
		// micro-cut sat inside it, and the fake inter-segment hole that left in the
		// compressed transcript read as a giant pause over real speech, which the
		// pacing detector then cut, pre-checked (review X1). Subtraction keeps the
		// survivors disjoint, sorted, and consistent with forwardRemapTime.
		let interior = 0;
		for (let j = ri; j < removals.length && removals[j].startSec < item.end; j++) {
			interior += Math.min(item.end, removals[j].endSec) - removals[j].startSec;
		}
		out.push({
			...item,
			start: item.start - removedBefore,
			end: item.end - removedBefore - interior,
		});
	}
	return out;
}

/**
 * Build the COMPRESSED words + segments by applying the accepted removals virtually.
 * `removals` must be the sorted disjoint output of `acceptedRemovalSpans`.
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
	return {
		words: applyRemovalsToItems(words, removals),
		segments: applyRemovalsToItems(segments, removals),
	};
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
	// U4: the compressed segments ride along so a compression-revealed
	// cross-sentence n-gram match gets the same HIGH_SIMILAR gate and demotion
	// as pass 1 instead of shipping AUTO ungated.
	const phraseRepeatCuts = detectPhraseRepeatCuts({ words, segments });
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

		// Dedup + keeper protection. Pass-1's blanket any-overlap dedup is WRONG here:
		// a repeat take revealed by compression legitimately CONTAINS the pass-1
		// micro-cuts made inside it (a filler, a duplicate word), and its inverse-mapped
		// span re-expands across those collapse points - dropping it for that overlap
		// silently ships the exact verbatim repeat this pass exists to catch. Instead:
		// an op overlapping no existing removal folds in as before; an overlapping op
		// survives only when it adds at least NEW_COVERAGE_FLOOR_SEC of footage no
		// existing removal op (accepted OR opt-in) already covers - a true re-detection
		// of an existing cut adds ~none and still dedups away.
		const allRemovalSpans = mergeSpans(
			allOps
				.filter(isRemoval)
				.map((op) => ({ startSec: op.startSec, endSec: op.endSec })),
		);
		const coveredSec = (op: DirectorOp): number => {
			let covered = 0;
			for (const r of allRemovalSpans) {
				covered += Math.max(
					0,
					Math.min(op.endSec, r.endSec) - Math.max(op.startSec, r.startSec),
				);
			}
			return covered;
		};
		const existingIds = new Set(allOps.map((op) => op.id));
		const fresh = originalCoordOps.filter((op) => {
			if (removalCoversKeeper({ op, keepers })) return false;
			const covered = coveredSec(op);
			if (covered > 0 && op.endSec - op.startSec - covered < NEW_COVERAGE_FLOOR_SEC) {
				return false;
			}
			if (existingIds.has(op.id)) return false;
			existingIds.add(op.id); // also dedups identical spans within this batch
			return true;
		});
		perPass.push(fresh.length);
		if (fresh.length === 0) break;

		extraOps.push(...fresh);
		// Grow the op set so the next pass compresses further and dedups against it.
		allOps = [...allOps, ...fresh].sort((a, b) => a.startSec - b.startSec);
	}

	return { extraOps, passesRun, perPass };
}
