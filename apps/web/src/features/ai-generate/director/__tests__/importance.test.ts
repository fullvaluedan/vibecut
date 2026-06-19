import { describe, expect, test } from "bun:test";
import { scoreImportance, type ImportanceSegment } from "../importance";
import type { SpeechFeatures } from "../types";

function feat({
	loudnessRelative,
	wpm,
	fillerCandidate = false,
}: {
	loudnessRelative: number;
	wpm: number;
	fillerCandidate?: boolean;
}): SpeechFeatures {
	return { startSec: 0, endSec: 0, energy: 0, loudnessRelative, wpm, wordCount: 0, fillerCandidate };
}

function seg({ text, durationSec = 2 }: { text: string; durationSec?: number }): ImportanceSegment {
	return { start: 0, end: durationSec, text };
}

describe("scoreImportance", () => {
	test("a loud, steady, content-dense segment scores high", () => {
		const [score] = scoreImportance({
			segments: [seg({ text: "the brand new editor ships today with motion templates", durationSec: 2.5 })],
			features: [feat({ loudnessRelative: 0.9, wpm: 150 })],
		});
		expect(score).toBeGreaterThan(0.7);
	});

	test("a loud BUT contentless filler segment does NOT score high (content gate)", () => {
		const dense = scoreImportance({
			segments: [seg({ text: "the brand new editor ships today with motion templates", durationSec: 2.5 })],
			features: [feat({ loudnessRelative: 0.9, wpm: 150 })],
		})[0];
		const loudFiller = scoreImportance({
			segments: [seg({ text: "um you know so the", durationSec: 2.5 })],
			features: [feat({ loudnessRelative: 0.9, wpm: 90, fillerCandidate: true })],
		})[0];
		expect(loudFiller).toBeLessThan(0.5);
		expect(loudFiller).toBeLessThan(dense);
	});

	test("honest-ceiling: a loud incidental-noun aside can outscore a quiet pivotal line (documents the limitation)", () => {
		const quietPivotal = scoreImportance({
			segments: [seg({ text: "that is the whole point" })],
			features: [feat({ loudnessRelative: 0.2, wpm: 95 })],
		})[0];
		const loudIncidental = scoreImportance({
			segments: [seg({ text: "anyway the camera tripod microphone cable adapter", durationSec: 2.5 })],
			features: [feat({ loudnessRelative: 0.95, wpm: 160 })],
		})[0];
		// The deterministic blend CANNOT rank taste — this is why the LLM is primary.
		expect(loudIncidental).toBeGreaterThan(quietPivotal);
	});

	test("a thesis marker raises the score vs the same delivery without it", () => {
		const features = [feat({ loudnessRelative: 0.8, wpm: 150 })];
		const withMarker = scoreImportance({
			segments: [seg({ text: "the key thing is the editor ships today", durationSec: 3 })],
			features,
		})[0];
		const without = scoreImportance({
			segments: [seg({ text: "the editor ships today", durationSec: 3 })],
			features,
		})[0];
		expect(withMarker).toBeGreaterThan(without);
	});

	test("scores stay distributed when no thesis markers are present (no degenerate collapse)", () => {
		const scores = scoreImportance({
			segments: [
				seg({ text: "the editor ships today with new templates" }),
				seg({ text: "um anyway" }),
				seg({ text: "motion graphics keyframes and easing curves matter" }),
			],
			features: [
				feat({ loudnessRelative: 0.8, wpm: 150 }),
				feat({ loudnessRelative: 0.2, wpm: 80, fillerCandidate: true }),
				feat({ loudnessRelative: 0.6, wpm: 140 }),
			],
		});
		const spread = Math.max(...scores) - Math.min(...scores);
		expect(spread).toBeGreaterThan(0.1);
	});

	test("rate confidence peaks in the healthy band — slow and fast both score below mid", () => {
		const text = "the editor ships today with new templates";
		const features = [
			feat({ loudnessRelative: 0.6, wpm: 90 }), // slow
			feat({ loudnessRelative: 0.6, wpm: 150 }), // mid
			feat({ loudnessRelative: 0.6, wpm: 230 }), // fast
		];
		const [slow, mid, fast] = scoreImportance({
			segments: [seg({ text }), seg({ text }), seg({ text })],
			features,
		});
		expect(mid).toBeGreaterThan(slow);
		expect(mid).toBeGreaterThan(fast);
	});

	test("zero-duration and empty segments score 0", () => {
		expect(
			scoreImportance({
				segments: [{ start: 5, end: 5, text: "anything" }],
				features: [feat({ loudnessRelative: 1, wpm: 150 })],
			})[0],
		).toBe(0);
		expect(scoreImportance({ segments: [seg({ text: "" })], features: [] })[0]).toBe(0);
	});

	test("a missing feature row degrades to lexical-only", () => {
		const [score] = scoreImportance({
			segments: [seg({ text: "the editor ships today with new templates" })],
			features: [], // no features → emphasis + rate contribute 0
		});
		expect(score).toBeGreaterThan(0); // lexical still scores
		expect(score).toBeLessThanOrEqual(0.4); // capped at the lexical weight
	});

	test("all scores are within [0,1]", () => {
		const scores = scoreImportance({
			segments: [
				seg({ text: "the key thing is everything matters most important", durationSec: 1 }),
				seg({ text: "uh", durationSec: 3 }),
			],
			features: [feat({ loudnessRelative: 1, wpm: 150 }), feat({ loudnessRelative: 0, wpm: 0 })],
		});
		for (const s of scores) {
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(1);
		}
	});
});
