import { describe, expect, test } from "bun:test";
import { buildTakeClusters } from "../take-clusters";
import type { AssetTranscript } from "../source-map";
import type { SpeechFeatures } from "../types";

function feat({
	startSec,
	endSec,
	loudnessRelative,
	fillerCandidate = false,
}: {
	startSec: number;
	endSec: number;
	loudnessRelative: number;
	fillerCandidate?: boolean;
}): SpeechFeatures {
	return { startSec, endSec, energy: 0, loudnessRelative, wpm: 120, wordCount: 8, fillerCandidate };
}

describe("buildTakeClusters", () => {
	test("clusters the same line across two clips as a TAKE; keeps the LATEST take (keep-last)", () => {
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "a", segments: [{ start: 0, end: 3, text: "today we ship the brand new editor", sourceStartSec: 0 }] },
			{ assetId: "b", segments: [{ start: 3, end: 6, text: "today we ship the brand new editor", sourceStartSec: 0 }] },
		];
		// Asset a is LOUDER, but recency wins outright now — the later take is kept.
		const features = [
			feat({ startSec: 0, endSec: 3, loudnessRelative: 0.85 }),
			feat({ startSec: 3, endSec: 6, loudnessRelative: 0.4 }),
		];

		const clusters = buildTakeClusters({ assetTranscripts, features });
		expect(clusters).toHaveLength(1);
		const c = clusters[0];
		expect(c.kind).toBe("take");
		expect(c.members).toHaveLength(2);
		// Keeper is the LATEST take (asset b at t=3), not the louder one.
		expect(c.members[c.keeperIndex].assetId).toBe("b");
		expect(c.similarity).toBeGreaterThanOrEqual(0.8);
	});

	test("keeps the LATEST take regardless of which take is louder", () => {
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "a", segments: [{ start: 0, end: 3, text: "let me walk you through the timeline view", sourceStartSec: 0 }] },
			{ assetId: "b", segments: [{ start: 10, end: 13, text: "let me walk you through the timeline view", sourceStartSec: 0 }] },
		];
		const features = [
			feat({ startSec: 0, endSec: 3, loudnessRelative: 0.5 }),
			feat({ startSec: 10, endSec: 13, loudnessRelative: 0.52 }),
		];

		const clusters = buildTakeClusters({ assetTranscripts, features });
		expect(clusters).toHaveLength(1);
		// Later take (asset b at t=10) is the keeper.
		expect(clusters[0].members[clusters[0].keeperIndex].assetId).toBe("b");
	});

	test("a far-apart same-asset restatement is a low-confidence REPEAT", () => {
		const assetTranscripts: AssetTranscript[] = [
			{
				assetId: "a",
				segments: [
					{ start: 0, end: 3, text: "welcome to the channel everyone glad you are here", sourceStartSec: 0 },
					{ start: 200, end: 203, text: "welcome to the channel everyone glad you are here", sourceStartSec: 200 },
				],
			},
		];
		const features = [
			feat({ startSec: 0, endSec: 3, loudnessRelative: 0.6 }),
			feat({ startSec: 200, endSec: 203, loudnessRelative: 0.6 }),
		];

		const clusters = buildTakeClusters({ assetTranscripts, features });
		expect(clusters).toHaveLength(1);
		expect(clusters[0].kind).toBe("repeat");
		expect(clusters[0].lowConfidence).toBe(true);
	});

	test("a long first member doesn't hide a far-apart callback (start-to-start span)", () => {
		// End-to-start gap is only 15s, but the takes are 70s apart start-to-start —
		// still callback territory, so it must stay low-confidence (KTD6).
		const assetTranscripts: AssetTranscript[] = [
			{
				assetId: "a",
				segments: [
					{ start: 0, end: 55, text: "and that is the whole story of how we got here today", sourceStartSec: 0 },
					{ start: 70, end: 73, text: "and that is the whole story of how we got here today", sourceStartSec: 70 },
				],
			},
		];
		const features = [
			feat({ startSec: 0, endSec: 55, loudnessRelative: 0.6 }),
			feat({ startSec: 70, endSec: 73, loudnessRelative: 0.6 }),
		];
		const clusters = buildTakeClusters({ assetTranscripts, features });
		expect(clusters).toHaveLength(1);
		expect(clusters[0].kind).toBe("repeat");
		expect(clusters[0].lowConfidence).toBe(true); // 70-0=70 > 60, not 70-55=15
	});

	test("members carry TIMELINE coordinates, not source time", () => {
		// Source starts at 0 but the clip is placed at timeline t=50.
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "a", segments: [{ start: 50, end: 53, text: "the most important thing to remember", sourceStartSec: 0 }] },
			{ assetId: "b", segments: [{ start: 53, end: 56, text: "the most important thing to remember", sourceStartSec: 0 }] },
		];
		const features = [
			feat({ startSec: 50, endSec: 53, loudnessRelative: 0.7 }),
			feat({ startSec: 53, endSec: 56, loudnessRelative: 0.6 }),
		];

		const clusters = buildTakeClusters({ assetTranscripts, features });
		expect(clusters).toHaveLength(1);
		expect(clusters[0].members[0].startSec).toBe(50); // timeline, not source 0
	});

	test("adjacent same-asset lines are NOT clustered (below the gap floor)", () => {
		const assetTranscripts: AssetTranscript[] = [
			{
				assetId: "a",
				segments: [
					{ start: 0, end: 2, text: "the most important thing to remember here", sourceStartSec: 0 },
					{ start: 2, end: 4, text: "the most important thing to remember here", sourceStartSec: 2 },
				],
			},
		];
		const features = [
			feat({ startSec: 0, endSec: 2, loudnessRelative: 0.6 }),
			feat({ startSec: 2, endSec: 4, loudnessRelative: 0.6 }),
		];
		// Adjacent (gap 0 < MIN_SAME_ASSET_GAP) → left to the verbatim detector, not clustered.
		expect(buildTakeClusters({ assetTranscripts, features })).toHaveLength(0);
	});

	test("distinct lines do not cluster", () => {
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "a", segments: [{ start: 0, end: 3, text: "here is how the export pipeline works", sourceStartSec: 0 }] },
			{ assetId: "b", segments: [{ start: 3, end: 6, text: "now subscribe and ring the notification bell", sourceStartSec: 0 }] },
		];
		const features = [
			feat({ startSec: 0, endSec: 3, loudnessRelative: 0.6 }),
			feat({ startSec: 3, endSec: 6, loudnessRelative: 0.6 }),
		];
		expect(buildTakeClusters({ assetTranscripts, features })).toHaveLength(0);
	});

	test("empty / single input yields no clusters", () => {
		expect(buildTakeClusters({ assetTranscripts: [], features: [] })).toHaveLength(0);
		expect(
			buildTakeClusters({
				assetTranscripts: [{ assetId: "a", segments: [{ start: 0, end: 1, text: "hi", sourceStartSec: 0 }] }],
				features: [feat({ startSec: 0, endSec: 1, loudnessRelative: 0.5 })],
			}),
		).toHaveLength(0);
	});
});
