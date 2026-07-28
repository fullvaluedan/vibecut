/**
 * Shared helpers for the deterministic Director cut detectors (duplicate-words,
 * filler-words, pacing). Pure + wasm-free so each detector stays unit-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";

/** One transcript word/segment with timeline-relative timing (seconds). */
export interface WordTiming {
	text: string;
	start: number;
	end: number;
}

/** Lowercase + strip surrounding punctuation; keep inner apostrophes/digits. */
export function normalizeWord(text: string): string {
	return text
		.toLowerCase()
		.replace(/^[^a-z0-9']+/, "")
		.replace(/[^a-z0-9']+$/, "");
}

/** djb2 → base36. Detectors prefix the input so ids don't collide across kinds. */
export function stableCutId(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/** A word-guard fragment shorter than this is dropped (mirrors remove-silences
 * MIN_REMOVED_SEC): a sub-0.2s splice buys nothing and risks a pop. */
export const STRIP_MIN_FRAGMENT_SEC = 0.2;

/**
 * The Director's standard containment test: true when the midpoint of
 * [spanStart, spanEnd) falls inside [containerStart, containerEnd). Used
 * across the pipeline to decide whether a word/segment/run "belongs to"
 * another span (word-guards, dead-air eligibility, hallucination screening,
 * phrase-repeat segment attribution, eval scoring): a boundary that only
 * grazes an edge should not count as touching it. Half-open by default (a
 * midpoint sitting exactly on containerEnd is NOT contained, matching the
 * [start, end) span convention used throughout Director); pass
 * `inclusiveEnd: true` for a closed interval (eval scoring only).
 */
export function isMidpointContained({
	spanStart,
	spanEnd,
	containerStart,
	containerEnd,
	inclusiveEnd = false,
}: {
	spanStart: number;
	spanEnd: number;
	containerStart: number;
	containerEnd: number;
	inclusiveEnd?: boolean;
}): boolean {
	const mid = (spanStart + spanEnd) / 2;
	return inclusiveEnd
		? mid >= containerStart && mid <= containerEnd
		: mid >= containerStart && mid < containerEnd;
}

/**
 * Word-guard for GAP-DERIVED removals (round 6 U5): a pacing/silence tighten
 * must never contain a real word. Splits the removal on every contained word
 * (midpoint containment) into word-free sub-spans, drops fragments under
 * `minFragmentSec`, and keeps all other op fields. Fragment ids extend the
 * original id (`<id>.w<n>`) so id-prefix consumers (the `sp-` premise guard)
 * still recognize the family. A removal containing no word midpoint returns
 * byte-identical `[op]`; non-removals pass through; empty words is fail-open.
 *
 * This is the belt on top of the emphasis-pause keepers and the second-pass
 * interior-subtraction fix: whatever asymmetry the inverse remap introduces,
 * an emitted gap-derived span cannot ship speech (live-test sp- bug, 3.75s
 * op swallowing a whole sentence).
 */
export function stripWordsFromRemoval({
	op,
	words,
	minFragmentSec = STRIP_MIN_FRAGMENT_SEC,
}: {
	op: DirectorOp;
	words: readonly WordTiming[];
	minFragmentSec?: number;
}): DirectorOp[] {
	if (op.op !== "cut" && op.op !== "take_select") {
		return [op];
	}
	const contained = words
		.filter((w) =>
			isMidpointContained({
				spanStart: w.start,
				spanEnd: w.end,
				containerStart: op.startSec,
				containerEnd: op.endSec,
			}),
		)
		.sort((a, b) => a.start - b.start);
	if (contained.length === 0) {
		return [op];
	}
	const fragments: DirectorOp[] = [];
	let cursor = op.startSec;
	let index = 0;
	const pushFragment = (startSec: number, endSec: number) => {
		if (endSec - startSec >= minFragmentSec) {
			fragments.push({ ...op, id: `${op.id}.w${index++}`, startSec, endSec });
		}
	};
	for (const w of contained) {
		pushFragment(cursor, Math.min(w.start, op.endSec));
		cursor = Math.max(cursor, w.end);
	}
	pushFragment(cursor, op.endSec);
	return fragments;
}

/** A timeline span that a take cluster decided to KEEP — never removable. */
export interface KeeperSpan {
	startSec: number;
	endSec: number;
}

/**
 * A removal must cover at least this fraction of a keeper to count as "removing the
 * take" (and be dropped). Below it, the removal is a micro-trim INSIDE the keeper (a
 * filler/dead-air/pacing word) and is left to do its job — protecting the take as a
 * whole must not suppress cleaning it up.
 */
const KEEPER_COVER_FRACTION = 0.5;

const isRemoval = (op: DirectorOp): boolean =>
	op.op === "cut" || op.op === "take_select";

/** Open-interval overlap: the two spans share more than a shared edge (seconds). */
export function spansOverlap(
	a: { startSec: number; endSec: number },
	b: { startSec: number; endSec: number },
): boolean {
	return a.startSec < b.endSec && b.startSec < a.endSec;
}

/**
 * Merge the DEFAULT-ACCEPTED removal spans (cut/take_select with `defaultAccept`
 * absent or true) into sorted, non-overlapping regions, so one covered region
 * reads as ONE cut: overlapping or edge-touching spans coalesce. Opt-in
 * (`defaultAccept: false`) rows are excluded entirely - they are review
 * questions, not applied cuts.
 *
 * The single source of the "what the assembled result actually removes"
 * derivation, shared by the join-texture layer and the assembled-transcript
 * builder so the two can never drift (KTD1). NOTE: swallow-pause.ts runs a
 * DIFFERENT accepted-removal pass (`clipByStartOrder`) that CLIPS overlapping
 * ops while PRESERVING op identity, rather than merging spans and discarding it;
 * those semantics differ deliberately, so that pass does not use this helper.
 */
export function mergeAcceptedRemovalSpans(
	ops: readonly DirectorOp[],
): { startSec: number; endSec: number }[] {
	const spans = ops
		.filter(
			(op) =>
				(op.op === "cut" || op.op === "take_select") && op.defaultAccept !== false,
		)
		.map((op) => ({ startSec: op.startSec, endSec: op.endSec }))
		.sort((a, b) => a.startSec - b.startSec);
	const merged: { startSec: number; endSec: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, span.endSec);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

/**
 * Merge deterministic detector cuts into a planner's ops in time order, with two
 * safety rules (KTD7):
 *
 * 1. **Keeper safety** — no removal (cut/take_select) from ANY source may delete a
 *    span a take cluster chose to keep. This also makes a cluster impossible to
 *    empty: if the LLM and the deterministic layer disagree on which take is the
 *    keeper, the LLM's removal of the protected keeper is dropped and the cluster
 *    keeps exactly the deterministic keeper.
 * 2. **Dedup** — a detector cut overlapping a surviving planner removal is dropped
 *    (the planner already cut that span).
 *
 * Non-removal ops (keep/reorder) always pass through. With `keepers` empty the
 * behavior is identical to the pre-cluster merge (regression-safe).
 */
/**
 * A removal "covers" a keeper when it overlaps >= KEEPER_COVER_FRACTION of it,
 * i.e. it would remove the take as a whole. A small intra-take trim overlaps only
 * a sliver and is NOT protected away (it still cleans up the kept take). Shared by
 * the pass-1 merge below and the second pass's own dedup so keeper semantics can
 * never drift between passes.
 */
export function removalCoversKeeper({
	op,
	keepers,
}: {
	op: { startSec: number; endSec: number };
	keepers: readonly KeeperSpan[];
}): boolean {
	return keepers.some((k) => {
		const overlap = Math.min(op.endSec, k.endSec) - Math.max(op.startSec, k.startSec);
		const keeperLen = k.endSec - k.startSec;
		return keeperLen > 0 && overlap / keeperLen >= KEEPER_COVER_FRACTION;
	});
}

export function mergeDetectedCuts({
	planOps,
	extraOps,
	keepers = [],
}: {
	planOps: DirectorOp[];
	extraOps: DirectorOp[];
	keepers?: readonly KeeperSpan[];
}): DirectorOp[] {
	const coversKeeper = (op: DirectorOp): boolean =>
		removalCoversKeeper({ op, keepers });

	// Rule 1, planner side: drop any LLM removal that would delete a keeper.
	const planKept = planOps.filter((op) => !(isRemoval(op) && coversKeeper(op)));

	const survivingRemovals = planKept.filter(isRemoval);
	const overlapsRemoval = (op: DirectorOp): boolean =>
		survivingRemovals.some((r) => spansOverlap(op, r));

	// Rule 1 (detector side) + rule 2: drop detector removals that would delete a
	// keeper, or that overlap a surviving planner removal.
	const fresh = extraOps.filter(
		(op) => !(isRemoval(op) && coversKeeper(op)) && !overlapsRemoval(op),
	);

	return [...planKept, ...fresh].sort((a, b) => a.startSec - b.startSec);
}
