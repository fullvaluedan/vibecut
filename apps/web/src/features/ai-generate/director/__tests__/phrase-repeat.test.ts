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

	// Round 6 U4: the whole-segment similarity gate.

	/** Segments derived from phrase() words: one segment per [text, startSec]. */
	function segs(
		...entries: [string, number, number][]
	): { text: string; start: number; end: number }[] {
		return entries.map(([text, start, end]) => ({ text, start, end }));
	}

	test("live false positive: 'We are going to' across different sentences demotes", () => {
		const a = "we are going to build it and walk you through that process";
		const b = "before we do that we are going to showcase the process because i need your help";
		const words = [...phrase({ text: a, startSec: 0 }), ...phrase({ text: b, startSec: 10 })];
		const ops = detectPhraseRepeatCuts({
			words,
			segments: segs([a, 0, 4.8], [b, 10, 16.4]),
		});
		expect(ops.length).toBeGreaterThanOrEqual(1);
		for (const op of ops) {
			expect(op.defaultAccept).toBe(false);
			expect(op.reason).toContain("DIFFERENT sentence");
		}
	});

	test("live false positive: 'You do not have to' across different sentences demotes", () => {
		const a = "you do not have to link to your google profile";
		const b = "you do not have to subscribe and you can join the group still";
		const words = [...phrase({ text: a, startSec: 0 }), ...phrase({ text: b, startSec: 6 })];
		const ops = detectPhraseRepeatCuts({
			words,
			segments: segs([a, 0, 4], [b, 6, 11.2]),
		});
		expect(ops.length).toBeGreaterThanOrEqual(1);
		for (const op of ops) {
			expect(op.defaultAccept).toBe(false);
		}
	});

	test("a true retake (near-identical segments) keeps its AUTO default", () => {
		const a = "so we grab the config file and restart the server";
		const b = "so we grab the config file and restart the server now";
		const words = [...phrase({ text: a, startSec: 0 }), ...phrase({ text: b, startSec: 6 })];
		const ops = detectPhraseRepeatCuts({
			words,
			segments: segs([a, 0, 4], [b, 6, 10.4]),
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBeUndefined();
		expect(ops[0].startSec).toBe(0); // earlier occurrence cut, later kept
	});

	test("without segments the legacy behavior is unchanged (no demotion)", () => {
		const a = "we are going to build it and walk you through that process";
		const b = "before we do that we are going to showcase the process because i need your help";
		const words = [...phrase({ text: a, startSec: 0 }), ...phrase({ text: b, startSec: 10 })];
		const ops = detectPhraseRepeatCuts({ words });
		for (const op of ops) {
			expect(op.defaultAccept).toBeUndefined();
		}
	});

	test("an occurrence whose midpoint falls outside every segment demotes (unconfirmed)", () => {
		const a = "this is the main point";
		const words = [
			...phrase({ text: a, startSec: 0 }),
			...phrase({ text: a, startSec: 3 }),
		];
		// Segments cover neither occurrence midpoint.
		const ops = detectPhraseRepeatCuts({
			words,
			segments: segs(["unrelated", 50, 55]),
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(false);
	});

	// Round 11: the same-segment vacuity hole in the U4 gate. When one segment holds
	// BOTH occurrences the similarity test compares it with itself and returns 1.0,
	// so it proves nothing and the row must not start checked.

	/** hermes 14:41 verbatim: a mid-sentence stumble Dan KEPT. */
	const stumble = "we are going to start this up we are going to launch a small instance";

	test("both occurrences inside ONE segment demotes (the self-comparison is vacuous)", () => {
		const words = phrase({ text: stumble, startSec: 0 }); // 15 words, 0.0-6.0
		const ops = detectPhraseRepeatCuts({
			words,
			segments: segs([stumble, 0, 6]),
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(false);
		expect(ops[0].reason).toContain("INSIDE one sentence");
		// Still PRODUCED, so review recall is unchanged: only the AUTO default moves.
		expect(ops[0].category).toBe("repeat");
		expect(ops[0].startSec).toBeCloseTo(0, 3); // earlier occurrence, as before
	});

	test("the same words split across two near-identical segments stay AUTO", () => {
		// Same stumble text, but the two occurrences land in DISTINCT segments whose
		// whole texts are near-identical: that is the real retake the U4 gate exists
		// to auto-accept, and round 11 must not disturb it.
		const a = "we are going to start this up";
		const b = "we are going to start this up now";
		const words = [...phrase({ text: a, startSec: 0 }), ...phrase({ text: b, startSec: 6 })];
		const ops = detectPhraseRepeatCuts({
			words,
			segments: segs([a, 0, 2.8], [b, 6, 9.2]),
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBeUndefined();
		expect(ops[0].reason).toContain("near-identical takes");
	});

	test("an EMPTY segments array keeps the legacy AUTO default (no same-segment demotion)", () => {
		const words = phrase({ text: stumble, startSec: 0 });
		const ops = detectPhraseRepeatCuts({ words, segments: [] });
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBeUndefined();
	});
});
