/**
 * KTD4 trim-vs-cut resolution (U4). A single post-merge pass that decides, per
 * removal op, whether it should TRIM a clip edge or stay a ripple-CUT:
 *
 * - A removal whose START or END lands within `toleranceSec` of a clip boundary is
 *   aligned to that boundary, so the removal trims the clip edge (no leftover
 *   sliver) instead of a cut that fragments the clip. An edge already exactly on a
 *   boundary is already a trim and is left as-is.
 * - A removal with BOTH edges mid-clip (neither within tolerance of a boundary) is
 *   left unchanged: it stays a ripple-cut.
 *
 * This changes only HOW a removal is expressed at the clip boundary, never WHAT
 * content is removed beyond swallowing the sub-tolerance sliver the snap was built
 * to absorb. The decision is centralized here (the detectors stay unchanged), and
 * the edge geometry reuses the proven `snapRemovalsToClipEdges` so there is exactly
 * one implementation of the clip-edge alignment. Non-removal ops pass through.
 *
 * Pure + wasm-free -> bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { snapRemovalsToClipEdges } from "./snap-cut";

export function resolveTrimVsCut({
	ops,
	clipStartsSec,
	clipEndsSec,
	toleranceSec,
}: {
	ops: readonly DirectorOp[];
	clipStartsSec: readonly number[];
	clipEndsSec: readonly number[];
	/** Snap window (seconds); a removal edge within this of a clip boundary trims to it. */
	toleranceSec: number;
}): DirectorOp[] {
	return snapRemovalsToClipEdges({ ops, clipStartsSec, clipEndsSec, toleranceSec });
}
