import { describe, expect, test } from "bun:test";
import {
	computeEmphasisPauseKeepers,
	MAX_PAUSE_SEC,
	WORD_BOUNDARY_SNAP_SEC,
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
