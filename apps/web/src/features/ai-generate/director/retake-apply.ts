/**
 * Pure mapping from the LLM retake pass's resolved cuts to the Director's review
 * layer (U3). Each above-floor retake cut becomes a flat `cut` op with category
 * `retake`, ALWAYS `defaultAccept: false` (OFFERED-only: the recall pass never auto-
 * removes newly-surfaced content, per R6/R10). Below the confidence floor the cut is
 * dropped entirely. The floor is the same 0.5 the redundancy pass uses.
 *
 * The retake pass resolves word-index spans to SECONDS inside hf-bridge, so this
 * module receives seconds and stays free of the word-index contract (seconds in/out
 * at the director layer). Pure + wasm-free → unit-tested. The flat cuts merge into
 * `build-director-proposals`'s ops UPSTREAM of the snap/refine/trim/justify chain, so
 * retake cuts inherit the mid-word / sliver guards like every other detected cut.
 */

import type { DirectorOp, RetakeCut } from "@framecut/hf-bridge";
import { removalCoversKeeper, stableCutId, type KeeperSpan } from "./cut-utils";
import { DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR } from "./redundancy-apply";

/**
 * Minimum surviving remainder after trimming a retake cut against existing removals
 * and keepers. Below this the sliver is noise, not a reviewable cut.
 */
export const MIN_RETAKE_REMAINDER_SEC = 0.3;

/**
 * Map resolved retake cuts to flat `cut` ops. A cut below the confidence FLOOR is
 * dropped; every surviving cut is OFFERED (`defaultAccept: false`, never auto-applied)
 * with category `retake`. Never emits `take_select`/`keep`/`reorder`. Ids follow the
 * same `stableCutId` convention as the sibling detectors.
 */
export function mapRetakeCuts({
	cuts,
	confidenceFloor = DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR,
}: {
	cuts: readonly RetakeCut[];
	confidenceFloor?: number;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (const cut of cuts) {
		if (cut.confidence < confidenceFloor) continue; // below floor → drop
		ops.push({
			id: `retake-${stableCutId(`${cut.startSec.toFixed(3)}:${cut.endSec.toFixed(3)}`)}`,
			op: "cut",
			startSec: cut.startSec,
			endSec: cut.endSec,
			reason: cut.reason ? cut.reason.slice(0, 240) : "Retake or false start",
			confidence: cut.confidence,
			category: "retake",
			// OFFERED-only: a retake row NEVER starts checked, whatever its confidence.
			defaultAccept: false,
		});
	}
	return ops;
}

/**
 * Trim retake cuts against spans the pipeline already owns, BEFORE the merge.
 * `mergeDetectedCuts` rule 2 drops an extra op WHOLE on any overlap with a surviving
 * removal, and the retake pass naturally brushes against existing cuts (the plan and
 * repeat passes cut fragments of the same flubbed material). Whole-drop threw away
 * the recall this pass exists to add, so each candidate is trimmed instead: the
 * portions overlapping existing removals or protected keepers are subtracted and the
 * remainders survive as their own OFFERED rows. Keepers subtract with the SAME
 * cover-fraction semantics as merge rule 1 (`removalCoversKeeper`): a keeper is a
 * hole only when the candidate overlaps enough of it to remove the take, so a
 * micro-trim INSIDE a keeper stays allowed, exactly as it is for every other
 * detector. Remainders shorter than `MIN_RETAKE_REMAINDER_SEC` drop as slivers.
 */
export function trimRetakeCuts({
	ops,
	blockers,
	keepers = [],
	minRemainderSec = MIN_RETAKE_REMAINDER_SEC,
	idNamespace = "retake",
}: {
	ops: readonly DirectorOp[];
	blockers: readonly KeeperSpan[];
	keepers?: readonly KeeperSpan[];
	minRemainderSec?: number;
	/** Prefix for a SPLIT piece's minted id (default `retake`; the structural pass passes
	 * `structural`). A structural piece and a retake piece trimming to the identical span
	 * must never mint the same id (review decisions key on op.id, so a collision would let
	 * one pass's accept/reject silently drive the other's row). A WHOLE (untrimmed) op keeps
	 * its already-namespaced caller id, so only split pieces read this. */
	idNamespace?: string;
}): DirectorOp[] {
	const blockerHoles = blockers
		.map((s) => ({ startSec: s.startSec, endSec: s.endSec }))
		.filter((s) => s.endSec > s.startSec);
	const out: DirectorOp[] = [];
	for (const op of ops) {
		// A keeper is a hole only when this candidate covers enough of it to remove
		// the take: the SAME removalCoversKeeper rule merge rule 1 uses, called per
		// keeper, so the two paths can never drift. Micro-trims inside keepers stay
		// allowed exactly as they are for every other detector.
		const keeperHoles = keepers.filter((k) =>
			removalCoversKeeper({ op, keepers: [k] }),
		);
		const holes = [...blockerHoles, ...keeperHoles]
			.map((s) => ({ startSec: s.startSec, endSec: s.endSec }))
			.sort((a, b) => a.startSec - b.startSec);
		let cursor = op.startSec;
		const pieces: Array<{ startSec: number; endSec: number }> = [];
		for (const hole of holes) {
			if (hole.endSec <= cursor) continue;
			if (hole.startSec >= op.endSec) break;
			if (hole.startSec > cursor) pieces.push({ startSec: cursor, endSec: hole.startSec });
			cursor = Math.max(cursor, hole.endSec);
			if (cursor >= op.endSec) break;
		}
		if (cursor < op.endSec) pieces.push({ startSec: cursor, endSec: op.endSec });
		for (const piece of pieces) {
			if (piece.endSec - piece.startSec < minRemainderSec) continue;
			const whole = piece.startSec === op.startSec && piece.endSec === op.endSec;
			out.push({
				...op,
				id: whole
					? op.id
					: `${idNamespace}-${stableCutId(`${piece.startSec.toFixed(3)}:${piece.endSec.toFixed(3)}`)}`,
				startSec: piece.startSec,
				endSec: piece.endSec,
			});
		}
	}
	return out;
}
