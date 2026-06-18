import { describe, expect, test } from "bun:test";
import { detectPhraseRepeatCuts } from "../phrase-repeat";
import type { WordTiming } from "../cut-utils";

// Build a phrase of evenly-timed words starting at `startSec` (0.4s/word default).
function phrase({
	text,
	startSec,
	perWord = 0.4,
}: {
	text: string;
	startSec: number;
	perWord?: number;
}): WordTiming[] {
	return text
		.trim()
		.split(/\s+/)
		.map((t, i) => ({
			text: t,
			start: +(startSec + i * perWord).toFixed(3),
			end: +(startSec + (i + 1) * perWord).toFixed(3),
		}));
}

describe("detectPhraseRepeatCuts", () => {
	test("cuts the EARLIER of two near-identical phrases (keeps the last take)", () => {
		const words = [
			...phrase({ text: "so we should ship it", startSec: 0 }), // 0.0–2.0 (first)
			...phrase({ text: "um", startSec: 2.0, perWord: 0.3 }), // a filler between
			...phrase({ text: "so we should ship it today", startSec: 2.3 }), // repeats the phrase
		];
		const ops = detectPhraseRepeatCuts({ words });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("repeat");
		// The cut is the EARLIER instance only — never the gap or the keeper.
		expect(ops[0].startSec).toBeCloseTo(0, 3);
		expect(ops[0].endSec).toBeCloseTo(2.0, 3);
	});

	test("greedily extends to the full repeated run, not just the minimum n-gram", () => {
		const words = [
			...phrase({ text: "let me show you how this works", startSec: 0 }), // 7 words
			...phrase({ text: "let me show you how this works perfectly", startSec: 5 }),
		];
		const ops = detectPhraseRepeatCuts({ words });
		expect(ops).toHaveLength(1);
		expect(ops[0].endSec).toBeCloseTo(2.8, 2); // all 7 words cut, not just 4
	});

	test("ignores a repeat shorter than the minimum phrase length", () => {
		const words = [
			...phrase({ text: "we should go", startSec: 0 }), // only 3 words match
			...phrase({ text: "um", startSec: 1.2, perWord: 0.3 }),
			...phrase({ text: "we should go now", startSec: 1.5 }),
		];
		expect(detectPhraseRepeatCuts({ words, minPhraseWords: 4 })).toHaveLength(0);
	});

	test("ignores a far-apart repeat (a deliberate callback, not a restart)", () => {
		const words = [
			...phrase({ text: "welcome to the channel everyone", startSec: 0 }),
			...phrase({ text: "welcome to the channel everyone", startSec: 200 }),
		];
		expect(detectPhraseRepeatCuts({ words, windowSeconds: 60 })).toHaveLength(0);
	});

	test("no repeats → no cuts", () => {
		expect(
			detectPhraseRepeatCuts({
				words: phrase({
					text: "this is a completely unique sentence here",
					startSec: 0,
				}),
			}),
		).toHaveLength(0);
	});

	test("a triple repeat cuts the first two, leaving the last", () => {
		const words = [
			...phrase({ text: "this is the main point", startSec: 0 }), // 0.0–2.0
			...phrase({ text: "this is the main point", startSec: 3 }), // 3.0–5.0
			...phrase({ text: "this is the main point", startSec: 6 }), // 6.0–8.0 (keeper)
		];
		const ops = detectPhraseRepeatCuts({ words });
		expect(ops).toHaveLength(2);
		expect(ops.map((o) => o.startSec)).toEqual([0, 3]); // first two cut, last kept
	});
});
