/**
 * Pure mapping from the LLM out-of-context plan (U3 Part B) to Director review ops.
 * The context pass reads the whole transcript and flags lines whose dialog does not
 * fit the video's throughline; here each flag becomes a `cut` op with
 * `category: "context"`. High-confidence flags (>= the shared redundancy accept
 * threshold) default-accept so clear mistakes / meta-asides actually leave the video
 * (2P-U4); lower-confidence flags stay OPT-IN review rows the user judges (semantic
 * relevance is false-positive-prone, so the uncertain band is never auto-cut).
 *
 * The request lines reuse `buildRedundancyCatalog`'s `RedundancyLine[]` (same
 * numbered transcript), so this module only owns the response->ops mapping + the
 * overlap filter. Pure + wasm-free -> bun-testable.
 */

import type { ContextFlag, DirectorOp } from "@framecut/hf-bridge";
import { stableCutId } from "./cut-utils";
import { DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD } from "./redundancy-apply";

const spansOverlap = (
	a: { startSec: number; endSec: number },
	b: { startSec: number; endSec: number },
): boolean => a.startSec < b.endSec && b.startSec < a.endSec;

/**
 * Map the context flags to `cut` ops, dropping any flag that overlaps a cut another
 * detector already made (so a context flag never doubles a repeat / dead-air /
 * redundancy removal). A flag with `endSec <= startSec` is skipped defensively.
 * The reason carries the LLM's "why this does not fit" through to the review row.
 * A flag at/above the accept threshold default-accepts; below it stays opt-in.
 */
export function mapContextFlags({
	flags,
	existingCuts = [],
}: {
	flags: readonly ContextFlag[];
	/** Removal ops already produced by the other detectors, for the overlap filter. */
	existingCuts?: readonly { startSec: number; endSec: number }[];
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (const flag of flags) {
		if (!(flag.endSec > flag.startSec)) continue; // defensive: empty / reversed span
		if (existingCuts.some((c) => spansOverlap(flag, c))) continue; // no double-flag
		// Confident flags (clear mistakes / self-corrections / wrong-video content)
		// default-accept so they actually leave; the uncertain band stays opt-in. A
		// non-finite confidence never auto-accepts (fail toward keeping the footage).
		const defaultAccept =
			Number.isFinite(flag.confidence) &&
			flag.confidence >= DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD;
		ops.push({
			id: `ctx-${stableCutId(`${flag.startSec.toFixed(3)}:${flag.endSec.toFixed(3)}`)}`,
			op: "cut",
			startSec: flag.startSec,
			endSec: flag.endSec,
			reason: flag.reason
				? `Out of context: ${flag.reason}`.slice(0, 240)
				: "Out of context: does not fit the video's throughline",
			confidence: flag.confidence,
			category: "context",
			defaultAccept,
		});
	}
	return ops;
}
