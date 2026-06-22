import { describe, expect, test } from "bun:test";
import {
	refineSilenceRanges,
	type ClipSpanSec,
	type SecRange,
} from "@/features/editing/silence-refine";

function refine({
	ranges,
	clipSpans,
}: {
	ranges: SecRange[];
	clipSpans: ClipSpanSec[];
}): SecRange[] {
	return refineSilenceRanges({ ranges, clipSpans, snapSec: 0.25, minSec: 0.2 });
}

describe("refineSilenceRanges — (a) protect whole video clips", () => {
	test("a padded silence covering a whole clip is dropped (showcase survives)", () => {
		// clip [0,10], silence padded inward to [0.15, 9.85] → snaps flush to [0,10]
		// → fully covers the clip → subtracted → nothing cut.
		expect(
			refine({
				ranges: [{ start: 0.15, end: 9.85 }],
				clipSpans: [{ startSec: 0, endSec: 10 }],
			}),
		).toEqual([]);
	});

	test("silence spanning a clip plus a trailing gap keeps only the gap", () => {
		// clip [0,10], silence [0.15, 14] → snap start→0 → [0,14]; subtract clip
		// [0,10] → keep [10,14] (the gap after the clip).
		expect(
			refine({
				ranges: [{ start: 0.15, end: 14 }],
				clipSpans: [{ startSec: 0, endSec: 10 }],
			}),
		).toEqual([{ start: 10, end: 14 }]);
	});
});

describe("refineSilenceRanges — (b) snap edges, no 4-frame remnant", () => {
	test("silence at a clip start snaps back to the clip start (no left sliver)", () => {
		expect(
			refine({
				ranges: [{ start: 0.15, end: 5 }],
				clipSpans: [{ startSec: 0, endSec: 20 }],
			}),
		).toEqual([{ start: 0, end: 5 }]);
	});

	test("silence at a clip end snaps out to the clip end (no right sliver)", () => {
		expect(
			refine({
				ranges: [{ start: 15, end: 19.85 }],
				clipSpans: [{ startSec: 0, endSec: 20 }],
			}),
		).toEqual([{ start: 15, end: 20 }]);
	});
});

describe("refineSilenceRanges — legitimate cuts pass through", () => {
	test("a mid-clip pause (far from boundaries) is cut unchanged", () => {
		expect(
			refine({
				ranges: [{ start: 8, end: 12 }],
				clipSpans: [{ startSec: 0, endSec: 20 }],
			}),
		).toEqual([{ start: 8, end: 12 }]);
	});

	test("silence over a gap with no clip is cut unchanged", () => {
		expect(refine({ ranges: [{ start: 5, end: 7 }], clipSpans: [] })).toEqual([
			{ start: 5, end: 7 },
		]);
	});

	test("sound-then-silence: the head sound is preserved (no snap to the far clip start)", () => {
		// clip [0,10] with sound [0,5]; silence [5.15, 9.85] → snap end→10 (start 5.15
		// is too far from clip start 0 to snap) → [5.15,10]; clip not fully covered.
		expect(
			refine({
				ranges: [{ start: 5.15, end: 9.85 }],
				clipSpans: [{ startSec: 0, endSec: 10 }],
			}),
		).toEqual([{ start: 5.15, end: 10 }]);
	});

	test("a leftover shorter than minSec is dropped", () => {
		expect(refine({ ranges: [{ start: 5, end: 5.1 }], clipSpans: [] })).toEqual(
			[],
		);
	});
});
