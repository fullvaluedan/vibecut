import { describe, expect, test } from "bun:test";
import { buildSignalTable, type TranscriptSegment } from "../build-signal-table";
import type { SourceMapElement } from "../source-map";
import type { SpeechFeatures } from "../types";

const TPS = 120_000;

// Two source clips assembled back to back: clipA [0,4s), clipB [4,8s).
const elements: SourceMapElement[] = [
	{ id: "e1", mediaId: "clipA", startTime: 0, duration: 4 * TPS, trimStart: 0 },
	{ id: "e2", mediaId: "clipB", startTime: 4 * TPS, duration: 4 * TPS, trimStart: 0 },
];

const feat = (o: Partial<SpeechFeatures> & Pick<SpeechFeatures, "startSec" | "endSec">): SpeechFeatures => ({
	energy: 0,
	loudnessRelative: 0,
	wpm: 0,
	wordCount: 0,
	fillerCandidate: false,
	...o,
});

describe("buildSignalTable", () => {
	test("maps source asset, zips features, and computes the silence gap", () => {
		const segments: TranscriptSegment[] = [
			{ start: 0.5, end: 3.5, text: "hello" },
			{ start: 4.5, end: 7.5, text: "world" },
		];
		const features: SpeechFeatures[] = [
			feat({ startSec: 0.5, endSec: 3.5, energy: 0.5, loudnessRelative: 1, wpm: 140, fillerCandidate: false }),
			feat({ startSec: 4.5, endSec: 7.5, energy: 0.1, loudnessRelative: 0.2, wpm: 60, fillerCandidate: true }),
		];

		const table = buildSignalTable({ segments, features, elements });

		expect(table[0]).toEqual({
			startSec: 0.5,
			endSec: 3.5,
			text: "hello",
			assetId: "clipA", // midpoint 2.0s -> clipA
			energy: 0.5,
			loudnessRelative: 1,
			wpm: 140,
			fillerCandidate: false,
			silenceBeforeSec: 0.5, // 0.5 - 0
		});
		expect(table[1].assetId).toBe("clipB"); // midpoint 6.0s -> clipB
		expect(table[1].wpm).toBe(60);
		expect(table[1].fillerCandidate).toBe(true);
		expect(table[1].silenceBeforeSec).toBe(1); // 4.5 - 3.5
	});

	test("omits feature fields when a feature row is missing", () => {
		const [row] = buildSignalTable({
			segments: [{ start: 0, end: 2, text: "x" }],
			features: [],
			elements,
		});
		expect(row.energy).toBeUndefined();
		expect(row.wpm).toBeUndefined();
		expect(row.assetId).toBe("clipA");
	});

	test("omits a sub-threshold (breath-length) silence gap", () => {
		const [, second] = buildSignalTable({
			segments: [
				{ start: 0, end: 2, text: "a" },
				{ start: 2.01, end: 4, text: "b" }, // 10ms gap < 0.05s
			],
			features: [],
			elements,
		});
		expect(second.silenceBeforeSec).toBeUndefined();
	});

	test("annotates a row with its cluster id when a clusterIds map is supplied", () => {
		const table = buildSignalTable({
			segments: [
				{ start: 0.5, end: 3.5, text: "hello" },
				{ start: 4.5, end: 7.5, text: "world" },
			],
			features: [],
			elements,
			clusterIds: new Map([[0.5, "C1"]]),
		});
		expect(table[0].clusterId).toBe("C1");
		expect(table[1].clusterId).toBeUndefined(); // not in the map
	});

	test("leaves clusterId unset when no map is supplied (regression-safe)", () => {
		const [row] = buildSignalTable({
			segments: [{ start: 0, end: 2, text: "x" }],
			features: [],
			elements,
		});
		expect(row.clusterId).toBeUndefined();
	});

	test("annotates importance per segment when supplied", () => {
		const table = buildSignalTable({
			segments: [
				{ start: 0, end: 2, text: "a" },
				{ start: 2, end: 4, text: "b" },
			],
			features: [],
			elements,
			importance: [0.9, 0.2],
		});
		expect(table[0].importance).toBe(0.9);
		expect(table[1].importance).toBe(0.2);
	});

	test("leaves importance unset when not supplied (regression-safe)", () => {
		const [row] = buildSignalTable({
			segments: [{ start: 0, end: 2, text: "x" }],
			features: [],
			elements,
		});
		expect(row.importance).toBeUndefined();
	});
});
