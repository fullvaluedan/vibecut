/**
 * Pure mapping from the LLM structural-drop pass's resolved drops to the Director's
 * review layer (U2). Each above-floor structural drop becomes a flat `cut` op with
 * category `structural`, ALWAYS `defaultAccept: false` (OFFERED-only: the recall pass
 * never auto-removes newly-surfaced sections, per R2/R10). Below the confidence floor
 * the drop is dropped entirely. The floor is the pass's own tuned
 * STRUCTURAL_CONFIDENCE_FLOOR (0.6), stricter than the sibling passes' 0.5.
 *
 * The structural pass resolves LINE-ID ranges to SECONDS inside hf-bridge, so this
 * module receives seconds and stays free of the line-id contract (seconds in/out at
 * the director layer). Pure + wasm-free → unit-tested. The flat cuts merge into
 * `build-director-proposals`'s ops via the SAME trim/fold path as the retake pass.
 */

import type { DirectorOp, StructuralDrop } from "@framecut/hf-bridge";
import { stableCutId } from "./cut-utils";

/**
 * The structural pass's own confidence floor, HIGHER than the 0.5 the redundancy and
 * retake passes use. Tuned on the how-to-edit fixture (2026-07-16): the model's
 * confidence is well calibrated for section drops, and every wrongly-flagged kept
 * word lived in the [0.5, 0.6) band (485 truth-cut vs 267 kept words, 1.8:1), while
 * drops at 0.6+ hit 322 truth-cut words with ZERO kept words. On small-kept-set
 * footage each kept word wrongly flagged costs the match metric double, so the floor
 * trades low-confidence recall for measured-perfect precision (R8's 3:1 gate).
 */
export const STRUCTURAL_CONFIDENCE_FLOOR = 0.6;

/**
 * R5b runaway-drop guard: a SINGLE structural candidate whose span covers more than
 * this fraction of the timeline is dropped at mapping time. A greedy L0-to-Llast range
 * resolves cleanly through the line-id contract and counts as a cut in OFFERED scoring,
 * cratering the exact match metric the pass is graded by; the capped importance floor
 * cannot protect most kept dialog from it. Tuned to 0.35: a legitimate multi-line
 * tangent drop (a section, not the whole video) passes, a near-whole-video range dies.
 * TUNABLE: raise if real section drops start dying, lower if greedy ranges leak.
 */
export const MAX_STRUCTURAL_DROP_FRACTION = 0.35;

/**
 * Map resolved structural drops to flat `cut` ops. A drop below the confidence FLOOR is
 * dropped; a SINGLE drop covering more than `maxDropFraction` of `totalSec` is dropped
 * (R5b runaway guard); every surviving drop is OFFERED (`defaultAccept: false`, never
 * auto-applied) with category `structural`. Never emits `take_select`/`keep`/`reorder`.
 * Ids follow the same `stableCutId` convention as the sibling detectors, prefixed
 * `structural-` so a structural row can never collide with a retake row on op.id.
 */
export function mapStructuralDrops({
	drops,
	totalSec,
	confidenceFloor = STRUCTURAL_CONFIDENCE_FLOOR,
	maxDropFraction = MAX_STRUCTURAL_DROP_FRACTION,
}: {
	drops: readonly StructuralDrop[];
	/** Timeline duration, for the runaway-drop guard's cover-fraction test. */
	totalSec: number;
	confidenceFloor?: number;
	maxDropFraction?: number;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (const drop of drops) {
		if (drop.confidence < confidenceFloor) continue; // below floor → drop
		// R5b: a single candidate that swallows more than the capped timeline fraction is
		// a greedy near-whole-video range, not a section, so drop it at mapping time.
		if (
			totalSec > 0 &&
			(drop.endSec - drop.startSec) / totalSec > maxDropFraction
		) {
			continue;
		}
		ops.push({
			id: `structural-${stableCutId(`${drop.startSec.toFixed(3)}:${drop.endSec.toFixed(3)}`)}`,
			op: "cut",
			startSec: drop.startSec,
			endSec: drop.endSec,
			reason: drop.reason ? drop.reason.slice(0, 240) : "Off-throughline section",
			confidence: drop.confidence,
			category: "structural",
			// OFFERED-only: a structural row NEVER starts checked, whatever its confidence.
			defaultAccept: false,
		});
	}
	return ops;
}
