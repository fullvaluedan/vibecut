import { describe, expect, test } from "bun:test";
import {
	pickSpread,
	selectDirectorFrameRequests,
	toVisionFrames,
} from "../director-frames";
import type { SourceMapElement } from "../source-map";
import type { TranscriptSegment } from "../build-signal-table";

// Pure selection math — plain-tick fixtures, no `@/wasm` mock (reuses the
// wasm-free `timelineTimeToSource`). The browser decode (`sampleDirectorFrames`)
// is verified live, not here.
const TPS = 120_000;
const sec = (s: number) => s * TPS;

function clip(
	overrides: Partial<SourceMapElement> &
		Pick<SourceMapElement, "id" | "mediaId" | "startTime" | "duration">,
): SourceMapElement {
	return { trimStart: 0, ...overrides };
}

describe("pickSpread", () => {
	test("returns all items when at or under the cap", () => {
		expect(pickSpread({ items: [1, 2, 3], max: 5 })).toEqual([1, 2, 3]);
		expect(pickSpread({ items: [1, 2, 3], max: 3 })).toEqual([1, 2, 3]);
	});

	test("an even spread over the cap keeps first and last, with distinct picks", () => {
		const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const picked = pickSpread({ items, max: 4 });
		expect(picked).toHaveLength(4);
		expect(picked[0]).toBe(0); // first retained
		expect(picked[picked.length - 1]).toBe(9); // last retained
		expect(new Set(picked).size).toBe(4); // no duplicate indices
	});

	test("degenerate caps: max=1 keeps the first, max<=0 keeps none", () => {
		expect(pickSpread({ items: [10, 20, 30], max: 1 })).toEqual([10]);
		expect(pickSpread({ items: [10, 20, 30], max: 0 })).toEqual([]);
	});
});

describe("selectDirectorFrameRequests", () => {
	// Two assets assembled back to back: assetA [0,4s), assetB [4s,9s).
	const elements: SourceMapElement[] = [
		clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(4) }),
		clip({ id: "e2", mediaId: "assetB", startTime: sec(4), duration: sec(5) }),
	];

	test("one request per segment, mapped to its source asset and time", () => {
		const segments: TranscriptSegment[] = [
			{ start: 1, end: 3, text: "in assetA" }, // mid 2s → assetA @ 2s
			{ start: 5, end: 7, text: "in assetB" }, // mid 6s → assetB @ 2s
		];
		const requests = selectDirectorFrameRequests({ segments, elements });
		expect(requests).toEqual([
			{ segmentIndex: 0, assetId: "assetA", sourceSec: 2 },
			{ segmentIndex: 1, assetId: "assetB", sourceSec: 2 },
		]);
	});

	test("segments over a gap (no element) are dropped", () => {
		const gapped: SourceMapElement[] = [
			clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(4) }),
		];
		const segments: TranscriptSegment[] = [
			{ start: 1, end: 3, text: "kept" }, // mid 2s → assetA
			{ start: 6, end: 8, text: "in a gap" }, // mid 7s → no element
		];
		const requests = selectDirectorFrameRequests({ segments, elements: gapped });
		expect(requests).toEqual([
			{ segmentIndex: 0, assetId: "assetA", sourceSec: 2 },
		]);
	});

	test("empty segments yield no requests", () => {
		expect(selectDirectorFrameRequests({ segments: [], elements })).toEqual([]);
	});

	test("caps the request count to maxImages with an even spread, preserving segment indices", () => {
		const big: SourceMapElement[] = [
			clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(100) }),
		];
		const segments: TranscriptSegment[] = Array.from({ length: 30 }, (_, i) => ({
			start: i * 2,
			end: i * 2 + 1,
			text: `seg ${i}`,
		}));
		const requests = selectDirectorFrameRequests({
			segments,
			elements: big,
			maxImages: 5,
		});
		expect(requests).toHaveLength(5);
		expect(requests[0].segmentIndex).toBe(0); // first segment kept
		expect(requests[requests.length - 1].segmentIndex).toBe(29); // last kept
		// Indices stay strictly increasing (we sampled across the timeline).
		const indices = requests.map((r) => r.segmentIndex);
		expect([...indices].sort((a, b) => a - b)).toEqual(indices);
	});
});

describe("toVisionFrames", () => {
	test("parses jpeg data URLs into segment-tagged base64 (no data: prefix)", () => {
		const wire = toVisionFrames([
			{ segmentIndex: 3, sourceSec: 1.2, dataUrl: "data:image/jpeg;base64,AAAB" },
			{ segmentIndex: 7, sourceSec: 4.0, dataUrl: "data:image/png;base64,CCCD" },
		]);
		expect(wire).toEqual([
			{ segmentIndex: 3, mediaType: "image/jpeg", dataBase64: "AAAB" },
			{ segmentIndex: 7, mediaType: "image/png", dataBase64: "CCCD" },
		]);
	});

	test("drops frames whose data URL can't be parsed", () => {
		const wire = toVisionFrames([
			{ segmentIndex: 0, sourceSec: 0, dataUrl: "not-a-data-url" },
			{ segmentIndex: 1, sourceSec: 1, dataUrl: "data:image/svg+xml;base64,ZZZ" }, // unsupported type
			{ segmentIndex: 2, sourceSec: 2, dataUrl: "data:image/webp;base64,WEBP" },
		]);
		expect(wire).toEqual([
			{ segmentIndex: 2, mediaType: "image/webp", dataBase64: "WEBP" },
		]);
	});
});
