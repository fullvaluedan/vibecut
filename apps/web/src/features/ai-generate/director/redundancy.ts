/**
 * Redundancy + take-selection detector (U4): turn take clusters into reviewable
 * removal ops, in TIMELINE coordinates.
 *
 * - A cross-asset cluster ("take") → `take_select` ops over each non-keeper.
 * - A far-apart same-asset cluster ("repeat") → `cut` ops over each non-keeper.
 * - A near-tie cluster → NO removal op; an informational note instead, so the
 *   user picks a take manually (KTD5 — never delete a coin-flip on batch-accept).
 *
 * Precision guard (KTD5): a member is only removed when its similarity to the
 * keeper clears HIGH_SIMILAR — a transitively-linked outlier (cluster cohesion
 * below threshold) is left for the LLM, never auto-removed. Far-apart same-asset
 * (callback) clusters get capped, low confidence (KTD6). All ops are review-
 * flagged; nothing here applies anything. Pure + wasm-free → bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { stableCutId } from "./cut-utils";
import { HIGH_SIMILAR, similarity } from "./text-similarity";
import type { ClusterMember, TakeCluster } from "./take-clusters";

/** Confidence cap for a far-apart same-asset (callback-risk) cut. */
const CALLBACK_CONFIDENCE_CAP = 0.45;
/** Hard ceiling so no review-flagged op reads as certain. */
const MAX_CONFIDENCE = 0.95;
/** Longest keeper preview embedded in a reason string. */
const MAX_PREVIEW_CHARS = 60;

/** An informational near-tie: two+ equally-good takes the user should choose between. */
export interface NearTieNote {
	kind: "take" | "repeat";
	/** Cluster cohesion (min pairwise similarity). */
	similarity: number;
	/** The candidate takes, in timeline order. */
	members: { assetId: string; startSec: number; endSec: number; text: string }[];
	/** Index INTO `members` of the take the ranker tentatively favored (latest). */
	suggestedKeeperIndex: number;
	/** Human-facing summary for the review modal. */
	reason: string;
}

function preview(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	return trimmed.length > MAX_PREVIEW_CHARS
		? `${trimmed.slice(0, MAX_PREVIEW_CHARS - 1)}…`
		: trimmed;
}

/** Confidence from similarity-to-keeper and the audio margin, capped for callbacks. */
function scoreConfidence({
	simToKeeper,
	audioMargin,
	lowConfidence,
}: {
	simToKeeper: number;
	audioMargin: number;
	lowConfidence: boolean;
}): number {
	const base =
		0.6 +
		Math.min(0.3, (simToKeeper - HIGH_SIMILAR) * 1.5) +
		Math.min(0.1, Math.max(0, audioMargin) * 0.25);
	const capped = Math.min(MAX_CONFIDENCE, base);
	return lowConfidence ? Math.min(CALLBACK_CONFIDENCE_CAP, capped) : capped;
}

function buildOp({
	member,
	keeper,
	cluster,
}: {
	member: ClusterMember;
	keeper: ClusterMember;
	cluster: TakeCluster;
}): DirectorOp {
	const simToKeeper = similarity({ a: member.text, b: keeper.text });
	const op = cluster.kind === "take" ? "take_select" : "cut";
	const category = cluster.kind === "take" ? "take" : "repeat";
	const keptWhen = keeper.startSec > member.startSec ? "later" : "clearer";
	const pct = Math.round(simToKeeper * 100);
	return {
		id: `red-${stableCutId(`${op}:${member.startSec.toFixed(3)}:${member.endSec.toFixed(3)}`)}`,
		op,
		startSec: member.startSec,
		endSec: member.endSec,
		reason: `Alternate take of "${preview(keeper.text)}" — kept the ${keptWhen} version (${pct}% match)`,
		confidence: scoreConfidence({
			simToKeeper,
			audioMargin: keeper.audioScore - member.audioScore,
			lowConfidence: cluster.lowConfidence,
		}),
		category,
	};
}

/**
 * Map take clusters to removal ops + near-tie notes. Returns ops in input order
 * (the orchestrator's merge re-sorts and dedups). A cluster with no decisive
 * keeper yields a note and no ops; a member below the keeper-similarity guard is
 * skipped entirely.
 */
export function detectRedundancyCuts({
	clusters,
}: {
	clusters: readonly TakeCluster[];
}): { ops: DirectorOp[]; nearTies: NearTieNote[] } {
	const ops: DirectorOp[] = [];
	const nearTies: NearTieNote[] = [];

	for (const cluster of clusters) {
		const keeper = cluster.members[cluster.keeperIndex];
		if (!keeper) continue;

		if (cluster.nearTie) {
			nearTies.push({
				kind: cluster.kind,
				similarity: cluster.similarity,
				members: cluster.members.map((m) => ({
					assetId: m.assetId,
					startSec: m.startSec,
					endSec: m.endSec,
					text: m.text,
				})),
				suggestedKeeperIndex: cluster.keeperIndex,
				reason: `${cluster.members.length} near-identical takes — pick one to cut`,
			});
			continue;
		}

		for (const member of cluster.members) {
			if (member.index === keeper.index) continue;
			// Precision guard: only remove a member genuinely matching the keeper.
			if (similarity({ a: member.text, b: keeper.text }) < HIGH_SIMILAR) continue;
			ops.push(buildOp({ member, keeper, cluster }));
		}
	}

	return { ops, nearTies };
}
