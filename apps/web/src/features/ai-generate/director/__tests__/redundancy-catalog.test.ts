import { describe, expect, test } from "bun:test";
import { buildRedundancyCatalog, type CatalogSegment } from "../redundancy-catalog";
import type { SourceMapElement } from "../source-map";
import type { SpeechFeatures } from "../types";

const TPS = 120_000;

const feat = ({
	startSec,
	endSec,
	loudnessRelative = 0.5,
	wpm = 130,
	fillerCandidate = false,
}: {
	startSec: number;
	endSec: number;
	loudnessRelative?: number;
	wpm?: number;
	fillerCandidate?: boolean;
}): SpeechFeatures => ({
	startSec,
	endSec,
	energy: loudnessRelative,
	loudnessRelative,
	wpm,
	wordCount: 5,
	fillerCandidate,
});

/** One main-track element covering [startSec, endSec) of the timeline. */
const elem = ({
	id,
	mediaId,
	startSec,
	endSec,
}: {
	id: string;
	mediaId: string;
	startSec: number;
	endSec: number;
}): SourceMapElement => ({
	id,
	mediaId,
	startTime: Math.round(startSec * TPS),
	duration: Math.round((endSec - startSec) * TPS),
	trimStart: 0,
});

const seg = ({ start, end, text }: { start: number; end: number; text: string }): CatalogSegment => ({
	start,
	end,
	text,
});

describe("buildRedundancyCatalog", () => {
	test("builds one line per segment with features + clip name joined", () => {
		const lines = buildRedundancyCatalog({
			segments: [seg({ start: 0, end: 2, text: "we ship friday" }), seg({ start: 3, end: 5, text: "launch is friday" })],
			features: [feat({ startSec: 0, endSec: 2, loudnessRelative: 0.8 }), feat({ startSec: 3, endSec: 5 })],
			elements: [elem({ id: "e1", mediaId: "m1", startSec: 0, endSec: 6 })],
			clipNameByAssetId: new Map([["m1", "clip.mp4"]]),
		});
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ lineId: "L0", startSec: 0, endSec: 2, text: "we ship friday", clipName: "clip.mp4", loudnessRelative: 0.8 });
		expect(lines[1].lineId).toBe("L1");
	});

	test("two segments at the same start-second get DISTINCT ids", () => {
		const lines = buildRedundancyCatalog({
			segments: [seg({ start: 1, end: 2, text: "x" }), seg({ start: 1, end: 2.5, text: "y" })],
			features: [],
			elements: [],
			clipNameByAssetId: new Map(),
		});
		expect(lines.map((l) => l.lineId)).toEqual(["L0", "L1"]);
	});

	test("omits feature fields when the parallel feature is absent (partial features)", () => {
		const lines = buildRedundancyCatalog({
			segments: [seg({ start: 0, end: 2, text: "a" }), seg({ start: 3, end: 5, text: "b" })],
			features: [feat({ startSec: 0, endSec: 2 })], // only L0 has a feature
			elements: [],
			clipNameByAssetId: new Map(),
		});
		expect(lines[0].loudnessRelative).toBe(0.5);
		expect(lines[1].loudnessRelative).toBeUndefined();
		expect(lines[1].wpm).toBeUndefined();
		expect(lines[1].fillerCandidate).toBeUndefined();
	});

	test("omits clipName when the segment has no source mapping (gap / unmapped)", () => {
		const lines = buildRedundancyCatalog({
			segments: [seg({ start: 0, end: 2, text: "over a gap" })],
			features: [feat({ startSec: 0, endSec: 2 })],
			elements: [], // nothing covers the midpoint
			clipNameByAssetId: new Map([["m1", "clip.mp4"]]),
		});
		expect(lines[0].clipName).toBeUndefined();
		expect("clipName" in lines[0]).toBe(false);
	});

	test("omits clipName when the asset has no name entry", () => {
		const lines = buildRedundancyCatalog({
			segments: [seg({ start: 0, end: 2, text: "a" })],
			features: [],
			elements: [elem({ id: "e1", mediaId: "unknown", startSec: 0, endSec: 6 })],
			clipNameByAssetId: new Map(), // no entry for "unknown"
		});
		expect(lines[0].clipName).toBeUndefined();
	});

	test("empty segments → empty catalog", () => {
		expect(
			buildRedundancyCatalog({ segments: [], features: [], elements: [], clipNameByAssetId: new Map() }),
		).toEqual([]);
	});
});
