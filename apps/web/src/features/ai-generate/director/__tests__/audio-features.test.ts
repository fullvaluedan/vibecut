import { describe, expect, test } from "bun:test";
import {
	computeEnergyEnvelope,
	computeSpeechFeatures,
	countWords,
	fillerRatio,
	isFillerSegment,
	lowConfidenceWordIndices,
	meanEnergyOverRange,
	speakingRateWpm,
} from "../audio-features";
import type { SpeechSegment } from "../types";

const SR = 16_000;

// RMS of a constant-amplitude region equals |amplitude|, so flat regions make the
// energy assertions exact without needing real audio.
function region({ secs, amp }: { secs: number; amp: number }): number[] {
	return new Array(Math.round(SR * secs)).fill(amp);
}
function buildSamples(regions: number[][]): Float32Array {
	return new Float32Array(regions.flat());
}

describe("computeEnergyEnvelope + meanEnergyOverRange", () => {
	test("RMS of a flat region equals its amplitude", () => {
		const samples = buildSamples([region({ secs: 1, amp: 0.5 })]);
		const envelope = computeEnergyEnvelope({ samples, sampleRate: SR });
		for (const value of envelope) expect(value).toBeCloseTo(0.5, 4);
		expect(meanEnergyOverRange({ envelope, windowSec: 0.05, startSec: 0, endSec: 1 })).toBeCloseTo(
			0.5,
			4,
		);
	});

	test("an out-of-range or empty span yields 0 energy", () => {
		const envelope = computeEnergyEnvelope({ samples: buildSamples([region({ secs: 1, amp: 0.3 })]), sampleRate: SR });
		expect(meanEnergyOverRange({ envelope, windowSec: 0.05, startSec: 5, endSec: 6 })).toBe(0);
		expect(meanEnergyOverRange({ envelope, windowSec: 0.05, startSec: 1, endSec: 1 })).toBe(0);
	});
});

describe("speakingRateWpm", () => {
	test("words per minute, with no divide-by-zero", () => {
		expect(speakingRateWpm({ wordCount: 120, durationSec: 60 })).toBe(120);
		expect(speakingRateWpm({ wordCount: 0, durationSec: 5 })).toBe(0);
		expect(speakingRateWpm({ wordCount: 10, durationSec: 0 })).toBe(0);
	});
});

describe("filler detection (heuristic fallback)", () => {
	test("fillerRatio counts whole-word and phrase fillers", () => {
		expect(fillerRatio("um uh like")).toBe(1);
		expect(fillerRatio("the cat sat on the mat")).toBe(0);
		// "you know" (2) + "i mean" (2) over 5 words.
		expect(fillerRatio("you know i mean stuff")).toBeCloseTo(0.8, 5);
	});

	test("isFillerSegment flags filler-dominated and quiet-trailing segments", () => {
		expect(
			isFillerSegment({ text: "um, uh, like", energy: 0.4, maxEnergy: 0.4, durationSec: 1 }),
		).toBe(true);
		// Quiet + short + has words → trailing-off mumble.
		expect(
			isFillerSegment({ text: "and then", energy: 0.01, maxEnergy: 0.5, durationSec: 0.8 }),
		).toBe(true);
		// A normal, loud, content-bearing line is not filler.
		expect(
			isFillerSegment({
				text: "the core idea is that compounding beats intensity",
				energy: 0.5,
				maxEnergy: 0.5,
				durationSec: 3,
			}),
		).toBe(false);
	});
});

describe("countWords + word-level confidence seam", () => {
	test("countWords tokenizes letters/digits/apostrophes", () => {
		// "3-step" splits on the hyphen → 3, step (fine for a word rate).
		expect(countWords("It's a 3-step plan, really!")).toBe(6);
		expect(countWords("   ")).toBe(0);
	});

	test("lowConfidenceWordIndices flags only low-confidence words", () => {
		const words = [
			{ word: "the", start: 0, end: 0.1, confidence: 0.9 },
			{ word: "um", start: 0.1, end: 0.3, confidence: 0.2 },
			{ word: "plan", start: 0.3, end: 0.5 }, // no confidence → not flagged
		];
		expect(lowConfidenceWordIndices({ words })).toEqual([1]);
	});
});

describe("computeSpeechFeatures (fused per-segment)", () => {
	test("a loud, fast segment scores higher energy + wpm than a quiet, slow filler one", () => {
		const samples = buildSamples([region({ secs: 1, amp: 0.5 }), region({ secs: 1, amp: 0.02 })]);
		const segments: SpeechSegment[] = [
			{ start: 0, end: 1, text: "the best way to really learn anything at all is to actually build it" },
			{ start: 1, end: 2, text: "um uh" },
		];
		const features = computeSpeechFeatures({ segments, samples, sampleRate: SR });

		expect(features[0].energy).toBeGreaterThan(features[1].energy);
		expect(features[0].wpm).toBeGreaterThan(features[1].wpm);
		expect(features[0].loudnessRelative).toBeCloseTo(1, 4); // loudest in the file
		expect(features[1].loudnessRelative).toBeLessThan(0.2);
		expect(features[1].fillerCandidate).toBe(true);
		expect(features[0].fillerCandidate).toBe(false);
	});

	test("a pure-silence segment returns zero energy and zero wpm (no NaN)", () => {
		const samples = buildSamples([region({ secs: 1, amp: 0 })]);
		const segments: SpeechSegment[] = [{ start: 0, end: 1, text: "" }];
		const features = computeSpeechFeatures({ segments, samples, sampleRate: SR });
		expect(features[0].energy).toBe(0);
		expect(features[0].wpm).toBe(0);
		expect(features[0].loudnessRelative).toBe(0);
		expect(Number.isNaN(features[0].energy)).toBe(false);
	});

	test("word-level tokens drive the word count when present", () => {
		const samples = buildSamples([region({ secs: 2, amp: 0.3 })]);
		const segments: SpeechSegment[] = [
			{
				start: 0,
				end: 2,
				text: "ignored for counting",
				words: [
					{ word: "two", start: 0, end: 1 },
					{ word: "words", start: 1, end: 2 },
				],
			},
		];
		const [feature] = computeSpeechFeatures({ segments, samples, sampleRate: SR });
		expect(feature.wordCount).toBe(2);
		expect(feature.wpm).toBe(60); // 2 words / 2s * 60
	});
});
