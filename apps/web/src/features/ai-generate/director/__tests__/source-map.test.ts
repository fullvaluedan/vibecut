import { describe, expect, test } from "bun:test";
import {
	groupTranscriptByAsset,
	timelineTimeToSource,
	type SourceMapElement,
	type TranscriptSegment,
} from "../source-map";

// Pure mapping math, so plain-tick fixtures suffice — no `@/wasm` mock needed
// (the module reuses the wasm-free `getSourceTimeAtClipTime`).
const TPS = 120_000;
const sec = (s: number) => s * TPS;

function clip(
	overrides: Partial<SourceMapElement> & Pick<SourceMapElement, "id" | "mediaId" | "startTime" | "duration">,
): SourceMapElement {
	return { trimStart: 0, ...overrides };
}

describe("timelineTimeToSource", () => {
	// Two assets assembled back to back: assetA [0,4s), assetB [4s,9s).
	const elements: SourceMapElement[] = [
		clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(4) }),
		clip({ id: "e2", mediaId: "assetB", startTime: sec(4), duration: sec(5) }),
	];

	test("maps a time inside the second clip to that asset with the right offset", () => {
		// 5s on the timeline = 1s into assetB (which starts at trimStart 0).
		const located = timelineTimeToSource({ timelineTicks: sec(5), elements });
		expect(located).toEqual({ assetId: "assetB", sourceSec: 1 });
	});

	test("accounts for trimStart (clip's source in-point)", () => {
		// assetA trimmed to start 2s into its source; 1s in on the timeline → source 3s.
		const trimmed: SourceMapElement[] = [
			clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(4), trimStart: sec(2) }),
		];
		const located = timelineTimeToSource({ timelineTicks: sec(1), elements: trimmed });
		expect(located).toEqual({ assetId: "assetA", sourceSec: 3 });
	});

	test("returns null over a gap (no element under the time)", () => {
		const gapped: SourceMapElement[] = [
			clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(4) }),
			clip({ id: "e2", mediaId: "assetB", startTime: sec(5), duration: sec(4) }),
		];
		expect(timelineTimeToSource({ timelineTicks: sec(4.5), elements: gapped })).toBeNull();
		// Past the end of all clips is also a gap.
		expect(timelineTimeToSource({ timelineTicks: sec(20), elements })).toBeNull();
	});

	test("maps a retimed (sped-up) clip proportionally", () => {
		// A 2× clip consumes source twice as fast: 2s on the timeline → 4s of source.
		const retimed: SourceMapElement[] = [
			clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(4), retime: { rate: 2 } }),
		];
		const located = timelineTimeToSource({ timelineTicks: sec(2), elements: retimed });
		expect(located).toEqual({ assetId: "assetA", sourceSec: 4 });
	});

	test("at an exact cut between adjacent clips, the later clip wins (half-open)", () => {
		const located = timelineTimeToSource({ timelineTicks: sec(4), elements });
		expect(located?.assetId).toBe("assetB");
		expect(located?.sourceSec).toBe(0);
	});
});

describe("groupTranscriptByAsset", () => {
	test("two source clips of the same line produce two per-asset transcripts", () => {
		// take1 and take2 each say the same scripted line, assembled back to back.
		const elements: SourceMapElement[] = [
			clip({ id: "e1", mediaId: "take1", startTime: 0, duration: sec(4) }),
			clip({ id: "e2", mediaId: "take2", startTime: sec(4), duration: sec(4) }),
		];
		const segments: TranscriptSegment[] = [
			{ start: 0.5, end: 3.5, text: "the best way to learn is to build" },
			{ start: 4.5, end: 7.5, text: "the best way to learn is to build" },
		];

		const grouped = groupTranscriptByAsset({ segments, elements });

		expect(grouped.map((g) => g.assetId)).toEqual(["take1", "take2"]);
		expect(grouped[0].segments).toHaveLength(1);
		expect(grouped[1].segments).toHaveLength(1);
		// Each segment carries where it starts in its own source.
		expect(grouped[0].segments[0].sourceStartSec).toBeCloseTo(0.5, 5);
		expect(grouped[1].segments[0].sourceStartSec).toBeCloseTo(0.5, 5);
		expect(grouped[0].segments[0].text).toBe("the best way to learn is to build");
	});

	test("drops segments that fall over a gap", () => {
		const elements: SourceMapElement[] = [
			clip({ id: "e1", mediaId: "assetA", startTime: 0, duration: sec(4) }),
		];
		const segments: TranscriptSegment[] = [
			{ start: 1, end: 3, text: "kept" },
			{ start: 6, end: 8, text: "in a gap, dropped" },
		];
		const grouped = groupTranscriptByAsset({ segments, elements });
		expect(grouped).toHaveLength(1);
		expect(grouped[0].assetId).toBe("assetA");
		expect(grouped[0].segments.map((s) => s.text)).toEqual(["kept"]);
	});
});
