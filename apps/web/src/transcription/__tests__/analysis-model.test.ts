import { describe, expect, test } from "bun:test";
import {
	ANALYSIS_TINY_THRESHOLD_SECONDS,
	selectAnalysisModel,
} from "../analysis-model";

describe("selectAnalysisModel (Plan A: words always on)", () => {
	// The whole point of Plan A is re-arming the word-level detectors, so the
	// analysis path must always pick a WORD-CAPABLE `_timestamped` export — never
	// a words-off model — at every length.
	const WORD_CAPABLE = "whisper-tiny-timestamped";
	const WORDS_OFF = new Set(["whisper-tiny", "whisper-small", "whisper-medium", "whisper-large-v3-turbo"]);

	test("returns the verified word-capable model at every length", () => {
		for (const durationSec of [0, 60, ANALYSIS_TINY_THRESHOLD_SECONDS, ANALYSIS_TINY_THRESHOLD_SECONDS + 1, 973.93]) {
			expect(selectAnalysisModel({ durationSec })).toBe(WORD_CAPABLE);
		}
	});

	test("never returns a words-off model", () => {
		for (const durationSec of [0, 300, 973.93]) {
			expect(WORDS_OFF.has(selectAnalysisModel({ durationSec }))).toBe(false);
		}
	});
});
