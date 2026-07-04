import { describe, expect, test } from "bun:test";
import { scoreImportance, selectProtectedSpans, type ImportanceSegment } from "../importance";
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

describe("selectProtectedSpans", () => {
	function segsOf(durations: number[]): { start: number; end: number }[] {
		let t = 0;
		return durations.map((d) => {
			const s = { start: t, end: t + d };
			t += d;
			return s;
		});
	}

	test("protects above-floor spans in timeline order", () => {
		// 12s timeline so two 2s protected spans (4s) stay under the 40% fraction cap.
		const out = selectProtectedSpans({
			segments: segsOf([2, 2, 2, 2, 2, 2]),
			importance: [0.9, 0.3, 0.3, 0.3, 0.8, 0.3],
		});
		expect(out).toEqual([
			{ startSec: 0, endSec: 2 }, // seg 0 (0.9)
			{ startSec: 8, endSec: 10 }, // seg 4 (0.8) — the rest below the floor
		]);
	});

	test("protects nothing when all scores are below the floor", () => {
		expect(
			selectProtectedSpans({ segments: segsOf([2, 2, 2]), importance: [0.3, 0.4, 0.2] }),
		).toEqual([]);
	});

	test("caps the count on uniformly-high footage (over-protection guard)", () => {
		const out = selectProtectedSpans({
			segments: segsOf(Array(20).fill(1)),
			importance: Array(20).fill(0.9),
		});
		expect(out.length).toBeLessThanOrEqual(8); // MAX_PROTECTED_SPANS — the cut still works on the rest
		expect(out.length).toBeLessThan(20);
	});

	test("caps the protected fraction of the timeline", () => {
		const out = selectProtectedSpans({
			segments: segsOf([10, 10, 10, 10, 10]),
			importance: Array(5).fill(0.9),
		});
		const protectedSec = out.reduce((a, s) => a + (s.endSec - s.startSec), 0);
		expect(out.length).toBeLessThan(5);
		expect(protectedSec).toBeLessThanOrEqual(25); // ~≤ 40% of the 50s timeline
	});

	test("always allows at least one protected span even past the fraction cap", () => {
		const out = selectProtectedSpans({
			segments: segsOf([100]),
			importance: [0.9],
			options: { maxFraction: 0.1 },
		});
		expect(out).toHaveLength(1);
	});
});
