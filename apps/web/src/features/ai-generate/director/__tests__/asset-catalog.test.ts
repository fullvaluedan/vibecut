import { describe, expect, test } from "bun:test";
import { buildAssetCatalog, type CatalogAsset } from "../asset-catalog";
import type { AssetTranscript } from "../source-map";
import type { SpeechFeatures } from "../types";

function feat(partial: Partial<SpeechFeatures> & { startSec: number; endSec: number }): SpeechFeatures {
	return {
		energy: 0,
		loudnessRelative: 0.5,
		wpm: 120,
		wordCount: 10,
		fillerCandidate: false,
		...partial,
	};
}

const assets: CatalogAsset[] = [
	{ id: "asset-a", name: "intro-take.mp4", durationSec: 30 },
	{ id: "asset-b", name: "outro-take.mp4", durationSec: 20 },
];

describe("buildAssetCatalog", () => {
	test("builds one entry per speech-bearing asset, in first-appearance order", () => {
		const assetTranscripts: AssetTranscript[] = [
			{
				assetId: "asset-a",
				segments: [
					{ start: 0, end: 2, text: "Hey everyone welcome back", sourceStartSec: 0 },
					{ start: 2, end: 5, text: "today we ship the editor", sourceStartSec: 2 },
				],
			},
			{
				assetId: "asset-b",
				segments: [{ start: 5, end: 7, text: "thanks for watching", sourceStartSec: 0 }],
			},
		];
		const features = [
			feat({ startSec: 0, endSec: 2, loudnessRelative: 0.8, wpm: 140 }),
			feat({ startSec: 2, endSec: 5, loudnessRelative: 0.6, wpm: 100, fillerCandidate: true }),
			feat({ startSec: 5, endSec: 7, loudnessRelative: 0.4, wpm: 90 }),
		];

		const catalog = buildAssetCatalog({ assetTranscripts, features, assets });

		expect(catalog).toHaveLength(2);
		expect(catalog.map((e) => e.assetId)).toEqual(["asset-a", "asset-b"]);

		const [a, b] = catalog;
		expect(a.name).toBe("intro-take.mp4");
		expect(a.durationSec).toBe(30);
		expect(a.segmentCount).toBe(2);
		expect(a.timelineStartSec).toBe(0);
		expect(a.timelineEndSec).toBe(5);
		expect(a.firstLine).toBe("Hey everyone welcome back");
		expect(a.lastLine).toBe("today we ship the editor");
		// Aggregate audio: mean loudness (0.8+0.6)/2, filler share 1/2.
		expect(a.audio?.meanLoudness).toBeCloseTo(0.7, 6);
		expect(a.audio?.fillerShare).toBeCloseTo(0.5, 6);

		expect(b.name).toBe("outro-take.mp4");
		expect(b.segmentCount).toBe(1);
		expect(b.firstLine).toBe("thanks for watching");
		expect(b.lastLine).toBe("thanks for watching");
	});

	test("omits an asset transcript with no segments (all-gap clip)", () => {
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "asset-a", segments: [{ start: 0, end: 2, text: "hello", sourceStartSec: 0 }] },
			{ assetId: "asset-b", segments: [] },
		];
		const catalog = buildAssetCatalog({
			assetTranscripts,
			features: [feat({ startSec: 0, endSec: 2 })],
			assets,
		});
		expect(catalog).toHaveLength(1);
		expect(catalog[0].assetId).toBe("asset-a");
	});

	test("omits the audio summary when no features join", () => {
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "asset-a", segments: [{ start: 9, end: 10, text: "no features here", sourceStartSec: 0 }] },
		];
		const catalog = buildAssetCatalog({ assetTranscripts, features: [], assets });
		expect(catalog).toHaveLength(1);
		expect(catalog[0].audio).toBeUndefined();
	});

	test("falls back to a hash name + 0 duration when asset meta is missing", () => {
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "unknown-asset-id", segments: [{ start: 0, end: 1, text: "x", sourceStartSec: 0 }] },
		];
		const catalog = buildAssetCatalog({ assetTranscripts, features: [], assets });
		expect(catalog[0].name).toBe("unknown-");
		expect(catalog[0].durationSec).toBe(0);
	});

	test("truncates a long line with an ellipsis", () => {
		const long = "word ".repeat(40).trim();
		const assetTranscripts: AssetTranscript[] = [
			{ assetId: "asset-a", segments: [{ start: 0, end: 1, text: long, sourceStartSec: 0 }] },
		];
		const catalog = buildAssetCatalog({ assetTranscripts, features: [], assets });
		expect(catalog[0].firstLine.length).toBeLessThanOrEqual(100);
		expect(catalog[0].firstLine.endsWith("…")).toBe(true);
	});
});
