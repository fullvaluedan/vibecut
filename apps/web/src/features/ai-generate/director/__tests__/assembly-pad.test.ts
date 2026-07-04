import { describe, expect, test } from "bun:test";
import { padAssemblyDraft, padSpanIntoSilence } from "../assembly-pad";
import type { CandidateSpan } from "../candidate-pool";
import type { AssemblyDraft } from "../assembly-draft";

const seg = ({ start, end }: { start: number; end: number }) => ({ start, end });

describe("padSpanIntoSilence", () => {
	test("expands into the gaps on both sides, capped by the pad", () => {
		// Segments [0,1] [2,3] [4,5]; pad the middle one — 1s gap on each side.
		const segments = [seg({ start: 0, end: 1 }), seg({ start: 2, end: 3 }), seg({ start: 4, end: 5 })];
		const out = padSpanIntoSilence({ startSec: 2, endSec: 3, durationSec: 5, segments, padSec: 0.06 });
		expect(out.startSec).toBeCloseTo(1.94, 3);
		expect(out.endSec).toBeCloseTo(3.06, 3);
	});

	test("does NOT pad into an abutting neighbour (no gap → no movement)", () => {
		// [0,1] abuts [1,2]; padding [1,2]'s start would eat the previous word.
		const segments = [seg({ start: 0, end: 1 }), seg({ start: 1, end: 2 })];
		const out = padSpanIntoSilence({ startSec: 1, endSec: 2, durationSec: 3, segments, padSec: 0.06 });
		expect(out.startSec).toBeCloseTo(1, 3); // unchanged — abuts the previous segment
		expect(out.endSec).toBeCloseTo(2.06, 3); // free tail → padded
	});

	test("clamps to the clip bounds [0, duration]", () => {
		// Lone segment near the clip head/tail; only a sliver of room on each side.
		const segments = [seg({ start: 0.03, end: 1.0 })];
		const out = padSpanIntoSilence({ startSec: 0.03, endSec: 1.0, durationSec: 1.04, segments, padSec: 0.06 });
		expect(out.startSec).toBeCloseTo(0, 3); // clamped at 0 (only 0.03 of head room)
		expect(out.endSec).toBeCloseTo(1.04, 3); // clamped at duration (only 0.04 tail)
	});

	test("caps the pad at the gap when the gap is smaller than padSec", () => {
		const segments = [seg({ start: 0, end: 1 }), seg({ start: 1.02, end: 2 })];
		// Pad [1.02,2]'s start: gap back to 1.0 is only 0.02s → pad 0.02, not 0.06.
		const out = padSpanIntoSilence({ startSec: 1.02, endSec: 2, durationSec: 2, segments, padSec: 0.06 });
		expect(out.startSec).toBeCloseTo(1.0, 3);
	});
});

describe("padAssemblyDraft", () => {
	const pool: CandidateSpan[] = [
		{ id: "a@0", assetId: "a", sourceStartSec: 0, sourceEndSec: 1, text: "one" },
		{ id: "a@2", assetId: "a", sourceStartSec: 2, sourceEndSec: 3, text: "two" },
		{ id: "b@0", assetId: "b", sourceStartSec: 0, sourceEndSec: 1, text: "other clip" },
	];

	const draft: AssemblyDraft = {
		spans: [
			{
				id: "a@2",
				assetId: "a",
				clipName: "a.mp4",
				sourceStartSec: 2,
				sourceEndSec: 3,
				sourceDurationSec: 5,
				dropped: false,
			},
		],
		alternatesByClusterId: {
			C1: [
				{
					assetId: "b",
					clipName: "b.mp4",
					sourceStartSec: 0,
					sourceEndSec: 1,
					sourceDurationSec: 4,
				},
			],
		},
	};

	test("pads spans + alternates and returns a NEW draft (input untouched)", () => {
		const out = padAssemblyDraft({ draft, pool, padSec: 0.06 });
		// Span in asset "a": prev segment ends at 1 (gap 1s), no next → tail to clip end.
		expect(out.spans[0].sourceStartSec).toBeCloseTo(1.94, 3);
		expect(out.spans[0].sourceEndSec).toBeCloseTo(3.06, 3);
		// Alternate in asset "b": lone segment, pads into head/tail within the clip.
		expect(out.alternatesByClusterId.C1[0].sourceStartSec).toBeCloseTo(0, 3);
		expect(out.alternatesByClusterId.C1[0].sourceEndSec).toBeCloseTo(1.06, 3);
		// Input draft is unchanged (pure).
		expect(draft.spans[0].sourceStartSec).toBe(2);
		expect(draft.spans[0].sourceEndSec).toBe(3);
	});

	test("a span only sees its OWN asset's segments", () => {
		// Asset "b" has just one segment; asset "a"'s segments must not bound it.
		const out = padAssemblyDraft({ draft, pool, padSec: 0.06 });
		// b's alternate padded only by its own clip bounds, not a's [0,1]/[2,3].
		expect(out.alternatesByClusterId.C1[0].sourceEndSec).toBeCloseTo(1.06, 3);
	});
});
