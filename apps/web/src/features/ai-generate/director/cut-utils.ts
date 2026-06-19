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

const spansOverlap = ({
	a,
	b,
}: {
	a: { startSec: number; endSec: number };
	b: { startSec: number; endSec: number };
}): boolean => a.startSec < b.endSec && b.startSec < a.endSec;

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
export function mergeDetectedCuts({
	planOps,
	extraOps,
	keepers = [],
}: {
	planOps: DirectorOp[];
	extraOps: DirectorOp[];
	keepers?: readonly KeeperSpan[];
}): DirectorOp[] {
	// A removal "covers" a keeper when it overlaps ≥ KEEPER_COVER_FRACTION of it —
	// i.e. it would remove the take as a whole. A small intra-take trim overlaps only
	// a sliver and is NOT protected away (it still cleans up the kept take).
	const coversKeeper = (op: DirectorOp): boolean =>
		keepers.some((k) => {
			const overlap = Math.min(op.endSec, k.endSec) - Math.max(op.startSec, k.startSec);
			const keeperLen = k.endSec - k.startSec;
			return keeperLen > 0 && overlap / keeperLen >= KEEPER_COVER_FRACTION;
		});

	// Rule 1, planner side: drop any LLM removal that would delete a keeper.
	const planKept = planOps.filter((op) => !(isRemoval(op) && coversKeeper(op)));

	const survivingRemovals = planKept.filter(isRemoval);
	const overlapsRemoval = (op: DirectorOp): boolean =>
		survivingRemovals.some((r) => spansOverlap({ a: op, b: r }));

	// Rule 1 (detector side) + rule 2: drop detector removals that would delete a
	// keeper, or that overlap a surviving planner removal.
	const fresh = extraOps.filter(
		(op) => !(isRemoval(op) && coversKeeper(op)) && !overlapsRemoval(op),
	);

	return [...planKept, ...fresh].sort((a, b) => a.startSec - b.startSec);
}
