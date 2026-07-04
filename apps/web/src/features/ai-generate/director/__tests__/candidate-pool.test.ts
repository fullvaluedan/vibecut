import { describe, expect, test } from "bun:test";
import { buildCandidatePool } from "@/features/ai-generate/director/candidate-pool";
import { buildTakeClustersFromPool } from "@/features/ai-generate/director/take-clusters";
import type { BinClipTranscript } from "@/features/ai-generate/director/asset-transcribe-helpers";
import type { SpeechFeatures } from "@/features/ai-generate/director/types";

function clip({
	assetId,
	segments,
}: {
	assetId: string;
	segments: { start: number; end: number; text: string }[];
}): BinClipTranscript {
	return { assetId, name: assetId, durationSec: 60, segments };
}

function feat({
	startSec,
	loudnessRelative,
}: {
	startSec: number;
	loudnessRelative: number;
}): SpeechFeatures {
	return {
		startSec,
		endSec: startSec + 3,
		energy: 0,
		loudnessRelative,
		wpm: 120,
		wordCount: 8,
		fillerCandidate: false,
	};
}

const LINE = "today we ship the brand new editor";

describe("buildCandidatePool", () => {
	test("flattens every segment of every clip into source-coord spans", () => {
		const pool = buildCandidatePool({
			clips: [
				clip({
					assetId: "a",
					segments: [
						{ start: 0, end: 3, text: "intro line" },
						{ start: 3, end: 6, text: "second line" },
					],
				}),
				clip({
					assetId: "b",
					segments: [{ start: 0, end: 4, text: "other clip line" }],
				}),
			],
		});
		expect(pool).toHaveLength(3);
		expect(pool[0]).toMatchObject({
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 3,
			text: "intro line",
		});
		expect(pool[2].assetId).toBe("b");
		// ids are stable + unique per (asset, start)
		expect(new Set(pool.map((s) => s.id)).size).toBe(3);
	});

	test("joins per-clip audio features by start second", () => {
		const pool = buildCandidatePool({
			clips: [clip({ assetId: "a", segments: [{ start: 0, end: 3, text: "x" }] })],
			featuresByAsset: new Map([
				["a", [feat({ startSec: 0, loudnessRelative: 0.7 })]],
			]),
		});
		expect(pool[0].audio?.loudnessRelative).toBe(0.7);
	});
});

describe("buildTakeClustersFromPool", () => {
	test("clusters the SAME line across two different bin clips as a cross-bin take", () => {
		const pool = buildCandidatePool({
			clips: [
				clip({ assetId: "a", segments: [{ start: 0, end: 3, text: LINE }] }),
				clip({ assetId: "b", segments: [{ start: 5, end: 8, text: LINE }] }),
			],
			featuresByAsset: new Map([
				["a", [feat({ startSec: 0, loudnessRelative: 0.5 })]],
				["b", [feat({ startSec: 5, loudnessRelative: 0.6 })]],
			]),
		});
		const clusters = buildTakeClustersFromPool({ pool });
		expect(clusters).toHaveLength(1);
		expect(clusters[0].kind).toBe("take"); // two different assets
		expect(clusters[0].members).toHaveLength(2);
	});

	test("distinct lines across clips do not cluster", () => {
		const pool = buildCandidatePool({
			clips: [
				clip({
					assetId: "a",
					segments: [{ start: 0, end: 3, text: "here is how the export works" }],
				}),
				clip({
					assetId: "b",
					segments: [{ start: 0, end: 3, text: "subscribe and ring the bell" }],
				}),
			],
		});
		expect(buildTakeClustersFromPool({ pool })).toHaveLength(0);
	});
});
