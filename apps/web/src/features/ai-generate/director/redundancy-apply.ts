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
import { stableCutId, type WordTiming } from "./cut-utils";
import { swallowPauseBounds } from "./swallow-pause";
import { refineCutWordBounds } from "./refine-cut-words";

/**
 * Groups below this LLM confidence are dropped entirely (inclusive at the floor).
 * Lowered from 0.7 to raise recall (#5): the [floor, accept-threshold) band is now
 * SURFACED as opt-in review rows rather than dropped, so more repeats reach the user.
 */
export const DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR = 0.5;

/**
 * Groups at/above this confidence start ACCEPTED in the review; groups in
 * [floor, this) are surfaced as accept-OFF rows the user opts into (never auto-cut).
 */
export const DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD = 0.7;

/** One redundancy group as the review panel sees it (keeper + all takes). */
export interface RedundancyReviewGroup {
	/** Stable id (g0, g1…) shared by this group's cut ops via `op.groupId`. */
	groupId: string;
	keeperLineId: string;
	members: RedundancyMember[];
	confidence: number;
	reason: string;
}

/** Build the single cut op for one non-keeper take. Shared by the initial mapping
 * and the swap recompute so a swapped group's ops are byte-shaped like the originals
 * (same id scheme, category, reason). */
function buildRedundancyCutOp({
	member,
	groupId,
	confidence,
	reason,
	defaultAccept = true,
}: {
	member: RedundancyMember;
	groupId: string;
	confidence: number;
	reason: string;
	/** Sub-floor groups pass `false` so their row starts unchecked (opt-in). */
	defaultAccept?: boolean;
}): DirectorOp {
	return {
		id: `redun-${stableCutId(`${member.startSec.toFixed(3)}:${member.endSec.toFixed(3)}`)}`,
		op: "cut",
		startSec: member.startSec,
		endSec: member.endSec,
		reason: reason
			? `Repeat — kept the best take (${reason})`.slice(0, 240)
			: "Repeat — kept the best of the takes",
		confidence,
		category: "redundancy",
		groupId,
		// Omit the field when accepted so above-threshold ops stay byte-shaped as
		// before (absent = accepted); only sub-threshold ops carry `false`.
		...(defaultAccept ? {} : { defaultAccept: false }),
	};
}

export interface MappedRedundancy {
	/** Flat cut ops over the non-keeper takes of every above-floor group. */
	cuts: DirectorOp[];
	/** The above-floor groups, for review rendering + swap-to-alternate. */
	groups: RedundancyReviewGroup[];
}

/**
 * Map redundancy groups to flat cut ops + review groups. A group below the
 * confidence FLOOR is dropped entirely; a group in [floor, acceptThreshold) is
 * SURFACED with accept-OFF cut ops (opt-in, never auto-cut — #5/R4); a group at/above
 * the threshold surfaces with accepted cut ops. A group that (defensively) has no
 * non-keeper member emits no cut. The keeper is never cut, even when it is the
 * EARLIEST take (best-delivered, not keep-last — KTD-8).
 */
export function mapRedundancyGroups({
	groups,
	confidenceFloor = DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR,
	acceptThreshold = DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD,
}: {
	groups: readonly RedundancyGroup[];
	confidenceFloor?: number;
	acceptThreshold?: number;
}): MappedRedundancy {
	const cuts: DirectorOp[] = [];
	const reviewGroups: RedundancyReviewGroup[] = [];

	// `gi` indexes only the SURFACED groups, so a group's id is stable across runs
	// of the same plan (below-floor / keeper-only groups never consume an index).
	let gi = 0;
	for (const group of groups) {
		if (group.confidence < confidenceFloor) continue; // below floor → drop
		const nonKeepers = group.members.filter((m) => m.lineId !== group.keeperLineId);
		if (nonKeepers.length === 0) continue; // keeper-only → nothing to cut (defensive)

		const groupId = `g${gi++}`;
		// Sub-threshold groups are opt-in: their cut ops start unchecked so the higher
		// recall never auto-cuts distinct content (R7); the user approves them per row.
		const defaultAccept = group.confidence >= acceptThreshold;
		for (const member of nonKeepers) {
			cuts.push(
				buildRedundancyCutOp({
					member,
					groupId,
					confidence: group.confidence,
					reason: group.reason,
					defaultAccept,
				}),
			);
		}
		reviewGroups.push({
			groupId,
			keeperLineId: group.keeperLineId,
			members: [...group.members],
			confidence: group.confidence,
			reason: group.reason,
		});
	}

	return { cuts, groups: reviewGroups };
}

/**
 * Swap-to-alternate (U5/R5): rebuild ONE group's cut ops for a newly-chosen keeper.
 * Drops every op tagged with this group's id and re-adds a cut over each new non-
 * keeper take, leaving every other op untouched; the result stays start-sorted for a
 * stable review order. Pure — the store calls it, then re-defaults the new ops to
 * accepted.
 *
 * KTD5 (U2): the rebuilt cuts are routed through the SAME energy-snap + word-boundary
 * refine chain the originally-mapped redundancy cuts flow through, instead of shipping
 * raw line spans. Pass `envelope` to energy-snap the edges and `words` to keep them off
 * mid-word landings; both are optional — omit them and the behavior is byte-identical
 * to the pre-U2 raw-span swap (snap needs a non-empty envelope; refine fails open with
 * no words). This fixes the live inconsistency where a swapped group bypassed snapping.
 */
export function applyKeeperSwap({
	operations,
	group,
	newKeeperLineId,
	acceptThreshold = DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD,
	envelope,
	words,
}: {
	operations: readonly DirectorOp[];
	group: RedundancyReviewGroup;
	newKeeperLineId: string;
	acceptThreshold?: number;
	/** RMS energy envelope for the edge snap; omit to skip energy-snapping. */
	envelope?: readonly number[];
	/** Transcript word timings for the mid-word refine; omit to fail open. */
	words?: readonly WordTiming[];
}): DirectorOp[] {
	// Defensive: a keeper that isn't a member of the group would make
	// cutMembersForKeeper cut EVERY take (total group loss). Treat an unknown
	// keeper as a no-op rather than deleting the whole group.
	if (!group.members.some((member) => member.lineId === newKeeperLineId)) {
		return [...operations];
	}
	// Preserve the group's accept default across a swap: a sub-threshold (accept-OFF)
	// group's rebuilt ops must STAY opt-in, or swapping its keeper would silently flip
	// the whole group to fully accepted (the rebuilt ops get new ids the store's
	// decision merge can't match, so it would fall back to accepted). Mirrors
	// `mapRedundancyGroups`'s `group.confidence >= acceptThreshold`.
	const defaultAccept = group.confidence >= acceptThreshold;
	const others = operations.filter((op) => op.groupId !== group.groupId);
	const rawRebuilt = cutMembersForKeeper({
		members: group.members,
		keeperLineId: newKeeperLineId,
	}).map((member) =>
		buildRedundancyCutOp({
			member,
			groupId: group.groupId,
			confidence: group.confidence,
			reason: group.reason,
			defaultAccept,
		}),
	);
	// KTD5 + round 6 U3: run the rebuilt cuts through the SAME placement chain the
	// main pipeline uses (pause-swallow with trough-snap fallback, then word-refine)
	// so a swapped group's joins match pipeline joins instead of regressing to the
	// old residual-leaving snap. Both steps no-op without their input (envelope /
	// words); the fixed-ceiling threshold applies here because this path has no
	// per-segment energies to compute the adaptive median from.
	const snapped =
		envelope && envelope.length > 0
			? swallowPauseBounds({ ops: rawRebuilt, envelope, words: words ?? [] })
			: rawRebuilt;
	const rebuilt = refineCutWordBounds({ ops: snapped, words });
	return [...others, ...rebuilt].sort((a, b) => a.startSec - b.startSec);
}

/**
 * Whether the lexical repeat detectors (take-clusters / phrase-repeat / segment-
 * repeat / the deterministic redundancy mapper) should run. They now ALWAYS run
 * (#5/R5): when the LLM redundancy pass succeeded they contribute ADDITIVELY as a
 * backstop for repeats it missed; when it errored they are the sole authority.
 * `mergeDetectedCuts` dedup + keeper protection make the union safe.
 */
export function shouldRunLexicalRepeatDetectors(): boolean {
	return true;
}

/**
 * The default accept state for a lexical repeat backstop cut. VERBATIM repeats
 * (phrase-repeat: a run of >=4 consecutive identical tokens, i.e. clearly-duplicate
 * content) auto-accept by default even when they are ADDITIVE to a successful LLM
 * redundancy pass, so obvious repeats leave the timeline without row-toggling
 * (U1/KTD2: high-confidence-only removal). The softer near-identical backstops
 * (segment-repeat, take-cluster redundancy) stay opt-in when additive and only take
 * the accepted default on route-error FALLBACK (`redundancyRan` false), where they
 * are the sole repeat authority (OQ3/R7).
 */
export function lexicalBackstopDefaultAccept({
	verbatim,
	redundancyRan,
}: {
	/** True for phrase-repeat (verbatim n-gram) cuts; false for the softer backstops. */
	verbatim: boolean;
	redundancyRan: boolean;
}): boolean {
	return verbatim || !redundancyRan;
}

/**
 * The takes to CUT for a given keeper choice — every member except the chosen
 * keeper. The review's swap-to-alternate (U5/R5) calls this when the user picks a
 * different keeper: the newly-chosen take survives and the rest (including the old
 * keeper) are cut. Swapping back to the CURRENT keeper returns the original cut set.
 */
export function cutMembersForKeeper({
	members,
	keeperLineId,
}: {
	members: readonly RedundancyMember[];
	keeperLineId: string;
}): RedundancyMember[] {
	return members.filter((member) => member.lineId !== keeperLineId);
}
