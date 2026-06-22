/**
 * Pure glue between the cross-bin pool/clusters and the assembly planner /
 * placement (FrameCut auto-assemble, P4). Wasm-free → bun-testable.
 */

import type { AssemblyCandidate, AssemblySpan } from "@framecut/hf-bridge";
import type { CandidateSpan } from "./candidate-pool";
import type { TakeCluster } from "./take-clusters";
import type { AssemblySpanInput } from "./assembly-placement";

/**
 * Build the planner's candidate list from the pool + cross-bin take clusters:
 * stamps each span with its cluster id (so the model sees which lines are
 * alternate takes) and its clip name + audio signals. The cluster member `index`
 * is the span's position in `pool`.
 */
export function buildAssemblyCandidates({
	pool,
	clusters,
	clipNameByAssetId,
}: {
	pool: readonly CandidateSpan[];
	clusters: readonly TakeCluster[];
	clipNameByAssetId: ReadonlyMap<string, string>;
}): AssemblyCandidate[] {
	const clusterIdByPoolIndex = new Map<number, string>();
	clusters.forEach((cluster, clusterIndex) => {
		for (const member of cluster.members) {
			clusterIdByPoolIndex.set(member.index, `C${clusterIndex + 1}`);
		}
	});

	return pool.map((span, index) => {
		const clusterId = clusterIdByPoolIndex.get(index);
		return {
			spanId: span.id,
			assetId: span.assetId,
			clipName: clipNameByAssetId.get(span.assetId) ?? span.assetId.slice(0, 8),
			sourceStartSec: span.sourceStartSec,
			sourceEndSec: span.sourceEndSec,
			text: span.text,
			...(clusterId !== undefined ? { clusterId } : {}),
			...(span.audio?.loudnessRelative !== undefined
				? { loudnessRelative: span.audio.loudnessRelative }
				: {}),
			...(span.audio?.wpm !== undefined ? { wpm: span.audio.wpm } : {}),
			...(span.audio?.fillerCandidate ? { fillerCandidate: true } : {}),
		};
	});
}

/**
 * Resolve the planner's chosen spans into placement inputs, looking up each
 * source clip's display name + full duration (for trimEnd). Spans whose asset has
 * since vanished from the bin are skipped.
 */
export function resolveAssemblySpanInputs({
	planSpans,
	assetInfoById,
}: {
	planSpans: readonly AssemblySpan[];
	assetInfoById: ReadonlyMap<string, { name: string; durationSec: number }>;
}): AssemblySpanInput[] {
	const out: AssemblySpanInput[] = [];
	for (const span of planSpans) {
		const info = assetInfoById.get(span.assetId);
		if (!info) continue;
		out.push({
			mediaId: span.assetId,
			name: info.name,
			sourceStartSec: span.sourceStartSec,
			sourceEndSec: span.sourceEndSec,
			sourceDurationSec: info.durationSec,
		});
	}
	return out;
}
