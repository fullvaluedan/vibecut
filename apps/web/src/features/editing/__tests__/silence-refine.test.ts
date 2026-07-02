import { describe, expect, test } from "bun:test";
import {
	dropEmphasisPauses,
	refineSilenceRanges,
	type ClipSpanSec,
	type SecRange,
	type SpeechLine,
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

describe("dropEmphasisPauses — keep short in-dialog pauses (U3)", () => {
	const PADDING = 0.15;
	// A silence [runStart, runEnd] is detected padded inward to [runStart+P, runEnd-P].
	const detected = (runStart: number, runEnd: number): SecRange => ({
		start: runStart + PADDING,
		end: runEnd - PADDING,
	});
	const line = (start: number, end: number): SpeechLine => ({ start, end, text: "w" });

	test("a 1.5s speech-bounded pause is KEPT (dropped from the cut list)", () => {
		const surviving = dropEmphasisPauses({
			ranges: [detected(5, 6.5)],
			segments: [line(4.5, 5), line(6.5, 7)], // speech ends at 5, resumes at 6.5
			paddingSec: PADDING,
		});
		expect(surviving).toHaveLength(0);
	});

	test("a 3s pause is still CUT (over the ceiling)", () => {
		const surviving = dropEmphasisPauses({
			ranges: [detected(5, 8)],
			segments: [line(4.5, 5), line(8, 8.5)],
			paddingSec: PADDING,
		});
		expect(surviving).toHaveLength(1);
	});

	test("a leading run (speech only after) is still CUT", () => {
		const surviving = dropEmphasisPauses({
			ranges: [detected(0, 2)],
			segments: [line(2, 2.5)], // nothing before the gap
			paddingSec: PADDING,
		});
		expect(surviving).toHaveLength(1);
	});

	test("padding is not double-counted: a 2.2s true pause (1.9s padded) is CUT", () => {
		// If the padded duration (1.9s) were used it would wrongly read as <=2s and be
		// kept; un-padding recovers the true 2.2s so it is correctly still cut.
		const surviving = dropEmphasisPauses({
			ranges: [detected(5, 7.2)],
			segments: [line(4.5, 5), line(7.2, 7.7)],
			paddingSec: PADDING,
		});
		expect(surviving).toHaveLength(1);
	});

	test("no cached transcript (empty segments) → prior behavior, ranges untouched", () => {
		const ranges = [detected(5, 6.5), detected(10, 13)];
		const surviving = dropEmphasisPauses({ ranges, segments: [], paddingSec: PADDING });
		expect(surviving).toEqual(ranges);
	});

	// FIX 2: the standalone Remove Silences caller now feeds WORD-level timings when
	// cached (getCachedWords), falling back to SEGMENT-level. A real Whisper segment
	// spans a whole sentence and swallows a mid-dialog pause, so segment boundaries
	// (2..10 here) never land within the classifier's 0.25s snap of the pause edges
	// (5, 6.5) — segment data degrades safely (no protection) while word data protects.
	describe("word- vs segment-granularity (realistic Whisper fixture)", () => {
		// One 8s sentence-level segment that CONTAINS the pause at [5, 6.5].
		const segment: SpeechLine = { start: 2, end: 10, text: "a long spoken sentence with a beat in it" };
		// The same speech as per-WORD timings: a word ends at 5.0, the next starts at 6.5.
		const words: SpeechLine[] = [line(4.6, 5), line(6.5, 6.9)];

		test("SEGMENT-only data leaves the pause in the cut list (degrades safely)", () => {
			const surviving = dropEmphasisPauses({
				ranges: [detected(5, 6.5)],
				segments: [segment],
				paddingSec: PADDING,
			});
			expect(surviving).toHaveLength(1); // not protected — segment edges too coarse
		});

		test("WORD-level data protects the same mid-segment pause", () => {
			const surviving = dropEmphasisPauses({
				ranges: [detected(5, 6.5)],
				segments: words,
				paddingSec: PADDING,
			});
			expect(surviving).toHaveLength(0); // kept — word edges snap to the gap
		});
	});
});

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
