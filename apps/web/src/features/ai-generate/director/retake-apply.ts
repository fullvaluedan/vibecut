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
import { stableCutId } from "./cut-utils";
import { DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR } from "./redundancy-apply";

/**
 * Map resolved retake cuts to flat `cut` ops. A cut below the confidence FLOOR is
 * dropped; every surviving cut is OFFERED (`defaultAccept: false`, never auto-applied)
 * with category `retake`. Never emits `take_select`/`keep`/`reorder`. Ids follow the
 * same `stableCutId` convention as the sibling detectors.
 */
export function mapRetakeCuts(
	cuts: readonly RetakeCut[],
	confidenceFloor: number = DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR,
): DirectorOp[] {
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
