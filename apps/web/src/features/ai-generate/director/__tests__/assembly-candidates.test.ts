import { describe, expect, test } from "bun:test";
import {
	buildAssemblyCandidates,
	resolveAssemblySpanInputs,
} from "@/features/ai-generate/director/assembly-candidates";
import type { CandidateSpan } from "@/features/ai-generate/director/candidate-pool";
import type { TakeCluster } from "@/features/ai-generate/director/take-clusters";
import type { AssemblySpan } from "@framecut/hf-bridge";

function span({
	id,
	assetId,
	text,
}: {
	id: string;
	assetId: string;
	text: string;
}): CandidateSpan {
	return { id, assetId, sourceStartSec: 0, sourceEndSec: 3, text };
}

describe("buildAssemblyCandidates", () => {
	test("stamps cluster ids onto pooled spans + resolves clip names", () => {
		const pool: CandidateSpan[] = [
			span({ id: "s0", assetId: "a", text: "the same line" }),
			span({ id: "s1", assetId: "a", text: "unique line" }),
			span({ id: "s2", assetId: "b", text: "the same line" }),
		];
		// pool[0] and pool[2] are a cross-bin take cluster (member.index = pool index)
		const clusters: TakeCluster[] = [
			{
				kind: "take",
				keeperIndex: 1,
				lowConfidence: false,
				similarity: 1,
				members: [
					{ index: 0, assetId: "a", startSec: 0, endSec: 3, text: "the same line", audioScore: 0 },
					{ index: 2, assetId: "b", startSec: 0, endSec: 3, text: "the same line", audioScore: 0 },
				],
			},
		];
		const candidates = buildAssemblyCandidates({
			pool,
			clusters,
			clipNameByAssetId: new Map([
				["a", "interview.mp4"],
				["b", "retake.mp4"],
			]),
		});
		expect(candidates).toHaveLength(3);
		expect(candidates[0]).toMatchObject({
			spanId: "s0",
			clipName: "interview.mp4",
			clusterId: "C1",
		});
		expect(candidates[1].clusterId).toBeUndefined(); // not in a cluster
		expect(candidates[2]).toMatchObject({ spanId: "s2", clusterId: "C1" });
	});
});

describe("resolveAssemblySpanInputs", () => {
	function planSpan(assetId: string): AssemblySpan {
		return {
			spanId: `span-${assetId}`,
			assetId,
			sourceStartSec: 1,
			sourceEndSec: 4,
			reason: "",
			confidence: 1,
		};
	}

	test("resolves name + source duration; skips spans whose asset is gone", () => {
		const inputs = resolveAssemblySpanInputs({
			planSpans: [planSpan("a"), planSpan("missing"), planSpan("b")],
			assetInfoById: new Map([
				["a", { name: "A.mp4", durationSec: 30 }],
				["b", { name: "B.mp4", durationSec: 20 }],
			]),
		});
		expect(inputs).toHaveLength(2); // "missing" dropped
		expect(inputs[0]).toEqual({
			mediaId: "a",
			name: "A.mp4",
			sourceStartSec: 1,
			sourceEndSec: 4,
			sourceDurationSec: 30,
		});
		expect(inputs[1].mediaId).toBe("b");
	});
});
