import { describe, expect, test } from "bun:test";
import {
	collectPauseGaps,
	computeEmphasisPauseKeepers,
	computeRepeatAdjacentPauseFloors,
	MAX_PAUSE_SEC,
	WORD_BOUNDARY_SNAP_SEC,
	WORD_PAUSE_GAP_MIN_SEC,
	type PauseGap,
	type RepeatSpan,
} from "../emphasis-pause";
import type { TranscriptWordLite } from "@/features/transcription/transcript-cache";

const word = (start: number, end: number, text = "w"): TranscriptWordLite => ({
	start,
	end,
	text,
});

// Speech bounding a gap [start, end]: a word ends AT start, a word begins AT end.
const boundedWords = (gap: PauseGap): TranscriptWordLite[] => [
	word(gap.start - 0.5, gap.start, "before"),
	word(gap.end, gap.end + 0.5, "after"),
];

describe("collectPauseGaps (review X3)", () => {
	const segments = [
		{ start: 0, end: 10 },
		{ start: 12, end: 20 },
	];

	test("includes inter-segment gaps", () => {
		const gaps = collectPauseGaps({ segments, words: [] });
		expect(gaps).toEqual([{ start: 10, end: 12 }]);
	});

	test("includes INTRA-segment word gaps at/above the floor (the beat VAD would cut)", () => {
		// A 1.7s mid-sentence dramatic pause inside segment [0,10]: segment gaps
		// alone missed it, so its VAD dead-air cut had no keeper (the X3 bug).
		const words = [word(0, 4.0), word(5.7, 10, "next")];
		const gaps = collectPauseGaps({ segments, words });
		expect(gaps).toContainEqual({ start: 4.0, end: 5.7 });
	});

	test("excludes sub-floor word gaps (inter-word spacing must not flood keepers)", () => {
		const words = [word(0, 1.0), word(1.2, 2.0, "next")]; // 0.2s < floor
		const gaps = collectPauseGaps({ segments, words });
		expect(gaps).not.toContainEqual({ start: 1.0, end: 1.2 });
		expect(WORD_PAUSE_GAP_MIN_SEC).toBeLessThan(0.8); // stays under pacing's floor
	});

	test("no words: segment gaps only (prior behavior)", () => {
		expect(collectPauseGaps({ segments, words: [] })).toHaveLength(1);
	});
});

describe("computeEmphasisPauseKeepers", () => {
	test("happy path: 1.5s speech-bounded gap, no repeat nearby -> one keeper", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		const keepers = computeEmphasisPauseKeepers({
			gaps: [gap],
			words: boundedWords(gap),
		});
		expect(keepers).toEqual([{ startSec: 5, endSec: 6.5 }]);
	});

	test("ceiling: a 2.5s gap (> maxPauseSec) is not kept", () => {
		const gap: PauseGap = { start: 5, end: 7.5 };
		const keepers = computeEmphasisPauseKeepers({
			gaps: [gap],
			words: boundedWords(gap),
		});
		expect(keepers).toEqual([]);
	});

	test("leading/trailing: speech on only one side -> no keeper", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		// Only a word ending at start; nothing begins at end (leading into dead air).
		const onlyBefore = [word(gap.start - 0.5, gap.start, "before")];
		expect(
			computeEmphasisPauseKeepers({ gaps: [gap], words: onlyBefore }),
		).toEqual([]);
		// Only a word beginning at end; nothing ends at start (trailing dead air).
		const onlyAfter = [word(gap.end, gap.end + 0.5, "after")];
		expect(
			computeEmphasisPauseKeepers({ gaps: [gap], words: onlyAfter }),
		).toEqual([]);
	});

	test("repeat proximity: a qualifying gap with a repeat within proximitySec -> no keeper", () => {
		const gap: PauseGap = { start: 5, end: 6.2 };
		const repeat: RepeatSpan = { startSec: 6.7, endSec: 7.5 }; // 0.5s after gap end
		const keepers = computeEmphasisPauseKeepers({
			gaps: [gap],
			words: boundedWords(gap),
			repeatSpans: [repeat],
		});
		expect(keepers).toEqual([]);
	});

	test("repeat outside proximity does NOT disqualify", () => {
		const gap: PauseGap = { start: 5, end: 6.2 };
		const repeat: RepeatSpan = { startSec: 8, endSec: 9 }; // 1.8s after gap end (> 1.0)
		const keepers = computeEmphasisPauseKeepers({
			gaps: [gap],
			words: boundedWords(gap),
			repeatSpans: [repeat],
		});
		expect(keepers).toEqual([{ startSec: 5, endSec: 6.2 }]);
	});

	test("edge: gap exactly at maxPauseSec is kept; one tick over is not", () => {
		const atCeiling: PauseGap = { start: 5, end: 5 + MAX_PAUSE_SEC };
		expect(
			computeEmphasisPauseKeepers({
				gaps: [atCeiling],
				words: boundedWords(atCeiling),
			}),
		).toHaveLength(1);

		const overCeiling: PauseGap = { start: 5, end: 5 + MAX_PAUSE_SEC + 0.01 };
		expect(
			computeEmphasisPauseKeepers({
				gaps: [overCeiling],
				words: boundedWords(overCeiling),
			}),
		).toEqual([]);
	});

	test("snap tolerance: a word edge just WITHIN snapSec still counts as speech-bounded", () => {
		// Words end/start 0.2s off the gap edges (inside the 0.25s snap) -> still bounded.
		const gap: PauseGap = { start: 5, end: 6.5 };
		const off = WORD_BOUNDARY_SNAP_SEC - 0.05; // 0.2s
		const withinSnap = [
			word(gap.start - 0.5, gap.start - off, "before"),
			word(gap.end + off, gap.end + 0.5, "after"),
		];
		expect(
			computeEmphasisPauseKeepers({ gaps: [gap], words: withinSnap }),
		).toEqual([{ startSec: 5, endSec: 6.5 }]);
	});

	test("snap tolerance: a word edge just OUTSIDE snapSec is not speech-bounded", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		const off = WORD_BOUNDARY_SNAP_SEC + 0.05; // 0.3s
		// The BEFORE word ends 0.3s early (outside snap); the AFTER word is tight.
		const outsideSnap = [
			word(gap.start - 0.5, gap.start - off, "before"),
			word(gap.end, gap.end + 0.5, "after"),
		];
		expect(
			computeEmphasisPauseKeepers({ gaps: [gap], words: outsideSnap }),
		).toEqual([]);
	});

	test("repeat proximity: a repeat BEFORE the gap start also disqualifies", () => {
		// Mirrors the after-the-gap test: a repeat ending 0.5s before the gap start is
		// within proximitySec (1.0s) of the leading edge -> no keeper.
		const gap: PauseGap = { start: 5, end: 6.2 };
		const repeat: RepeatSpan = { startSec: 3.5, endSec: 4.5 };
		expect(
			computeEmphasisPauseKeepers({
				gaps: [gap],
				words: boundedWords(gap),
				repeatSpans: [repeat],
			}),
		).toEqual([]);
	});

	test("degenerate gaps: zero-duration and inverted spans yield no keeper", () => {
		const zero: PauseGap = { start: 5, end: 5 };
		expect(
			computeEmphasisPauseKeepers({ gaps: [zero], words: boundedWords(zero) }),
		).toEqual([]);
		const inverted: PauseGap = { start: 6.5, end: 5 };
		expect(
			computeEmphasisPauseKeepers({
				gaps: [inverted],
				// Provide words at both raw coordinates so only the duration check rejects it.
				words: [word(4.5, 5, "a"), word(6.5, 7, "b")],
			}),
		).toEqual([]);
	});

	test("words unavailable: empty words -> [] regardless of gaps", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		expect(computeEmphasisPauseKeepers({ gaps: [gap], words: [] })).toEqual([]);
	});

	test("purity: inputs are not mutated", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		const gaps = [gap];
		const words = boundedWords(gap);
		const repeatSpans: RepeatSpan[] = [{ startSec: 20, endSec: 21 }];
		const gapsSnapshot = JSON.stringify(gaps);
		const wordsSnapshot = JSON.stringify(words);
		const repeatSnapshot = JSON.stringify(repeatSpans);
		computeEmphasisPauseKeepers({ gaps, words, repeatSpans });
		expect(JSON.stringify(gaps)).toBe(gapsSnapshot);
		expect(JSON.stringify(words)).toBe(wordsSnapshot);
		expect(JSON.stringify(repeatSpans)).toBe(repeatSnapshot);
	});
});

describe("computeRepeatAdjacentPauseFloors", () => {
	// 15 frames at 30fps = 0.5s of silence left behind.
	const FLOOR = 15 / 30;
	// A repeat sitting 0.2s after the gap end (well within proximitySec).
	const nearRepeat = (gap: PauseGap): RepeatSpan => ({
		startSec: gap.end + 0.2,
		endSec: gap.end + 1,
	});

	test("repeat-adjacent 1.5s pause -> tightened to leave exactly the 15-frame floor", () => {
		const gap: PauseGap = { start: 5, end: 6.5 }; // 1.5s
		const cuts = computeRepeatAdjacentPauseFloors({
			gaps: [gap],
			words: boundedWords(gap),
			repeatSpans: [nearRepeat(gap)],
			floorSec: FLOOR,
		});
		expect(cuts).toHaveLength(1);
		// The cut removes everything but a trailing FLOOR remnant before the next word.
		expect(cuts[0].startSec).toBeCloseTo(5, 6);
		expect(cuts[0].endSec).toBeCloseTo(6, 6);
		const remainingSilence = gap.end - cuts[0].endSec;
		expect(remainingSilence).toBeCloseTo(FLOOR, 6);
	});

	test("no repeat nearby -> no floor cut (kept whole as a beat elsewhere)", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		expect(
			computeRepeatAdjacentPauseFloors({
				gaps: [gap],
				words: boundedWords(gap),
				repeatSpans: [{ startSec: 20, endSec: 21 }],
				floorSec: FLOOR,
			}),
		).toEqual([]);
	});

	test("pause already within the floor -> no cut (never widens a pause)", () => {
		const gap: PauseGap = { start: 5, end: 5.4 }; // 0.4s < 0.5s floor
		expect(
			computeRepeatAdjacentPauseFloors({
				gaps: [gap],
				words: boundedWords(gap),
				repeatSpans: [nearRepeat(gap)],
				floorSec: FLOOR,
			}),
		).toEqual([]);
	});

	test("pause over the ceiling (> maxPauseSec) -> no floor cut (dead air, cut whole)", () => {
		const gap: PauseGap = { start: 5, end: 5 + MAX_PAUSE_SEC + 0.5 };
		expect(
			computeRepeatAdjacentPauseFloors({
				gaps: [gap],
				words: boundedWords(gap),
				repeatSpans: [nearRepeat(gap)],
				floorSec: FLOOR,
			}),
		).toEqual([]);
	});

	test("speech on only one side -> no floor cut (leading/trailing air, not a beat)", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		const onlyBefore = [word(gap.start - 0.5, gap.start, "before")];
		expect(
			computeRepeatAdjacentPauseFloors({
				gaps: [gap],
				words: onlyBefore,
				repeatSpans: [nearRepeat(gap)],
				floorSec: FLOOR,
			}),
		).toEqual([]);
	});

	test("words unavailable / non-positive floor -> []", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		expect(
			computeRepeatAdjacentPauseFloors({
				gaps: [gap],
				words: [],
				repeatSpans: [nearRepeat(gap)],
				floorSec: FLOOR,
			}),
		).toEqual([]);
		expect(
			computeRepeatAdjacentPauseFloors({
				gaps: [gap],
				words: boundedWords(gap),
				repeatSpans: [nearRepeat(gap)],
				floorSec: 0,
			}),
		).toEqual([]);
	});

	test("purity: inputs are not mutated", () => {
		const gap: PauseGap = { start: 5, end: 6.5 };
		const gaps = [gap];
		const words = boundedWords(gap);
		const repeatSpans = [nearRepeat(gap)];
		const gapsSnapshot = JSON.stringify(gaps);
		const wordsSnapshot = JSON.stringify(words);
		const repeatSnapshot = JSON.stringify(repeatSpans);
		computeRepeatAdjacentPauseFloors({ gaps, words, repeatSpans, floorSec: FLOOR });
		expect(JSON.stringify(gaps)).toBe(gapsSnapshot);
		expect(JSON.stringify(words)).toBe(wordsSnapshot);
		expect(JSON.stringify(repeatSpans)).toBe(repeatSnapshot);
	});
});
