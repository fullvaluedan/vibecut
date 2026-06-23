/**
 * Pure mapping from the LLM redundancy plan to the Director's review/apply layer
 * (U4). Turns each above-confidence-floor group into flat `cut` ops over its
 * NON-keeper takes (`category: "redundancy"`), and surfaces the group structure
 * (keeper + all takes) for the review panel's swap-to-alternate (U5). Also the pure
 * gating predicate that decides whether the lexical repeat detectors run (R7).
 *
 * Pure + wasm-free → unit-tested. The flat `cuts` merge into `run-director`'s
 * `operations` UPSTREAM of the energy/clip-edge snap chain (System-Wide Impact), so
 * redundancy cuts inherit the mid-word / sliver guards.
 */

import type { DirectorOp, RedundancyGroup, RedundancyMember } from "@framecut/hf-bridge";
import { stableCutId } from "./cut-utils";

/** Groups below this LLM confidence are dropped (KTD-3, inclusive at the floor). */
export const DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR = 0.7;

/** One redundancy group as the review panel sees it (keeper + all takes). */
export interface RedundancyReviewGroup {
	keeperLineId: string;
	members: RedundancyMember[];
	confidence: number;
	reason: string;
}

export interface MappedRedundancy {
	/** Flat cut ops over the non-keeper takes of every above-floor group. */
	cuts: DirectorOp[];
	/** The above-floor groups, for review rendering + swap-to-alternate. */
	groups: RedundancyReviewGroup[];
}

/**
 * Map redundancy groups to flat cut ops + review groups. A group below the
 * confidence floor is dropped entirely; a group that (defensively) has no non-keeper
 * member emits no cut. The keeper is never cut, even when it is the EARLIEST take
 * (best-delivered, not keep-last — KTD-8).
 */
export function mapRedundancyGroups({
	groups,
	confidenceFloor = DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR,
}: {
	groups: readonly RedundancyGroup[];
	confidenceFloor?: number;
}): MappedRedundancy {
	const cuts: DirectorOp[] = [];
	const reviewGroups: RedundancyReviewGroup[] = [];

	for (const group of groups) {
		if (group.confidence < confidenceFloor) continue; // below floor → drop
		const nonKeepers = group.members.filter((m) => m.lineId !== group.keeperLineId);
		if (nonKeepers.length === 0) continue; // keeper-only → nothing to cut (defensive)

		for (const member of nonKeepers) {
			cuts.push({
				id: `redun-${stableCutId(`${member.startSec.toFixed(3)}:${member.endSec.toFixed(3)}`)}`,
				op: "cut",
				startSec: member.startSec,
				endSec: member.endSec,
				reason: group.reason
					? `Repeat — kept the best take (${group.reason})`.slice(0, 240)
					: "Repeat — kept the best of the takes",
				confidence: group.confidence,
				category: "redundancy",
			});
		}
		reviewGroups.push({
			keeperLineId: group.keeperLineId,
			members: [...group.members],
			confidence: group.confidence,
			reason: group.reason,
		});
	}

	return { cuts, groups: reviewGroups };
}

/**
 * Whether the lexical repeat detectors (take-clusters / phrase-repeat / segment-
 * repeat / the deterministic redundancy mapper) should run. They are the
 * ROUTE-ERROR FALLBACK (KTD-5): when the redundancy pass ran (success, even with
 * zero groups), the LLM pass is the authority and the lexical detectors stay
 * silent; only when the pass errored do they run.
 */
export function shouldRunLexicalRepeatDetectors({
	redundancyRan,
}: {
	redundancyRan: boolean;
}): boolean {
	return !redundancyRan;
}
