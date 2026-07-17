import { describe, expect, test } from "bun:test";
import {
	computeSilenceThreshold,
	guardHallucinations,
	MAX_PLAUSIBLE_WORD_SEC,
	SILENCE_RMS_CEILING,
} from "../hallucination-guard";

const WIN = 0.05;

/** Envelope covering [0, seconds) at WIN hop, filled with `level`, with
 * optional [start, end, level] overrides painted on top. */
function envelope(
	seconds: number,
	base: number,
	...spans: [number, number, number][]
): number[] {
	const env = new Array<number>(Math.round(seconds / WIN)).fill(base);
	for (const [s, e, level] of spans) {
		for (let w = Math.floor(s / WIN); w < Math.min(env.length, Math.ceil(e / WIN)); w++) {
			env[w] = level;
		}
	}
	return env;
}

/** Space-delimited text into evenly spaced words across [startSec, endSec). */
function spread(text: string, startSec: number, endSec: number) {
	const tokens = text.split(/\s+/);
	const step = (endSec - startSec) / tokens.length;
	return tokens.map((t, i) => ({
		text: t,
		start: startSec + i * step,
		end: startSec + (i + 1) * step,
	}));
}

function seg(text: string, start: number, end: number) {
	return { text, start, end };
}

describe("guardHallucinations", () => {
	test("flags the live-run tail: 'Thank you.' with 9-21s words over silence", () => {
		const words = [
			...spread("I need app testers and that is an issue", 0.92, 3.68),
			{ text: "Thank", start: 59.92, end: 69.2 },
			{ text: "you.", start: 69.2, end: 83.86 },
		];
		const segments = [
			seg("I need app testers and that is an issue.", 0.96, 3.68),
			seg("Thank you.", 59.92, 83.86),
		];
		// Real speech is loud (0.05); everything after 57.7 is near-silence.
		const env = envelope(84, 0.05, [57.7, 84, 0.0004]);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		expect(result.cleanSegments).toHaveLength(1);
		expect(result.cleanSegments[0].text).toContain("app testers");
		expect(result.survivingSegmentIndices).toEqual([0]);
		expect(result.cleanWords.some((w) => w.text === "Thank")).toBe(false);
		expect(result.cleanWords.some((w) => w.text === "you.")).toBe(false);
		expect(result.cleanWords).toHaveLength(9);
		expect(result.hallucinatedSpans).toHaveLength(1);
		expect(result.hallucinatedSpans[0].startSec).toBeCloseTo(59.92, 3);
		expect(result.hallucinatedSpans[0].endSec).toBeCloseTo(83.86, 3);
	});

	test("real quiet speech with normal word durations is NOT flagged", () => {
		const words = [
			...spread("this part is loud and clear speech here", 0, 4),
			...spread("and this is a quiet aside spoken softly", 5, 7),
		];
		const segments = [
			seg("this part is loud and clear speech here", 0, 4),
			seg("and this is a quiet aside spoken softly", 5, 7),
		];
		// The aside is quiet enough to sit below the threshold, but its words
		// are 0.25s each at 240 wpm: the text screen refuses to flag it.
		const env = envelope(8, 0.06, [5, 7, 0.001]);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		expect(result.cleanSegments).toHaveLength(2);
		expect(result.hallucinatedSpans).toHaveLength(0);
		expect(result.cleanWords).toHaveLength(16);
	});

	test("a loud absurd-duration word is NOT flagged (energy criterion fails)", () => {
		const words = [
			...spread("normal speech before the held note", 0, 3),
			{ text: "aaaaah", start: 4, end: 4 + MAX_PLAUSIBLE_WORD_SEC + 6 },
		];
		const segments = [
			seg("normal speech before the held note", 0, 3),
			seg("aaaaah", 4, 4 + MAX_PLAUSIBLE_WORD_SEC + 6),
		];
		const env = envelope(14, 0.06);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		expect(result.cleanSegments).toHaveLength(2);
		expect(result.hallucinatedSpans).toHaveLength(0);
	});

	test("empty envelope passes everything through unchanged (fail-open)", () => {
		const words = [{ text: "Thank", start: 0, end: 20 }];
		const segments = [seg("Thank", 0, 20)];
		const result = guardHallucinations({ words, segments, envelope: [], windowSec: WIN });

		expect(result.cleanWords).toEqual(words);
		expect(result.cleanSegments).toEqual(segments);
		expect(result.survivingSegmentIndices).toEqual([0]);
		expect(result.hallucinatedSpans).toHaveLength(0);
	});

	test("flagged segment extending past the envelope end clamps cleanly", () => {
		const words = [
			...spread("real speech at the start of the clip", 0, 3),
			{ text: "you.", start: 4, end: 30 },
		];
		const segments = [
			seg("real speech at the start of the clip", 0, 3),
			seg("you.", 4, 30),
		];
		// Envelope only covers 10s; the flagged segment runs to 30s.
		const env = envelope(10, 0.05, [4, 10, 0.0002]);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		expect(result.hallucinatedSpans).toHaveLength(1);
		expect(result.hallucinatedSpans[0].endSec).toBeCloseTo(30, 3);
		expect(result.cleanWords.some((w) => w.text === "you.")).toBe(false);
	});

	test("majority-hallucinated footage: pre-screened median keeps flagging alive", () => {
		const words = [
			{ text: "Thank", start: 0, end: 9 },
			{ text: "you.", start: 9, end: 20 },
			{ text: "Thank", start: 20, end: 29 },
			{ text: "you.", start: 29, end: 40 },
			{ text: "Thanks", start: 40, end: 49 },
			{ text: "all.", start: 49, end: 60 },
			...spread("one real sentence spoken normally right here", 61, 64),
		];
		const segments = [
			seg("Thank you.", 0, 20),
			seg("Thank you.", 20, 40),
			seg("Thanks all.", 40, 60),
			seg("one real sentence spoken normally right here", 61, 64),
		];
		// Three near-silent hallucinated segments outnumber the one real one.
		const env = envelope(65, 0.0003, [61, 64, 0.05]);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		// The median comes from the ONE screened (real) segment, so the
		// threshold stays meaningful and all three hallucinations are flagged.
		expect(result.cleanSegments).toHaveLength(1);
		expect(result.survivingSegmentIndices).toEqual([3]);
		expect(result.hallucinatedSpans).toHaveLength(1);
		expect(result.hallucinatedSpans[0].startSec).toBeCloseTo(0, 3);
		expect(result.hallucinatedSpans[0].endSec).toBeCloseTo(60, 3);
		expect(result.cleanWords).toHaveLength(7);
	});

	test("no flags: result arrays match inputs and every index survives", () => {
		const words = spread("clean speech only in this whole recording", 0, 4);
		const segments = [seg("clean speech only in this whole recording", 0, 4)];
		const env = envelope(5, 0.05);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		expect(result.cleanWords).toEqual(words);
		expect(result.cleanSegments).toEqual(segments);
		expect(result.survivingSegmentIndices).toEqual([0]);
	});

	test("review fix: a zero median falls back to the ceiling instead of collapsing to 0", () => {
		// Muted/digitally-silent audio with a transcript: median energy 0 must
		// NOT produce threshold 0 (strict < 0 would disable everything).
		expect(computeSilenceThreshold([0, 0, 0])).toBeCloseTo(SILENCE_RMS_CEILING, 6);
		expect(computeSilenceThreshold([])).toBeCloseTo(SILENCE_RMS_CEILING, 6);
	});

	test("review fix: sparse real speech in a trailing-pause segment is NOT flagged", () => {
		// A quiet but REAL 'Okay' (energetic word span) inside a 7s segment of
		// room tone: the whole-segment mean is silent but the word span is not.
		const words = [
			...spread("normal speech before the pause segment here", 0, 4),
			{ text: "Okay.", start: 5.2, end: 5.6 },
		];
		const segments = [
			seg("normal speech before the pause segment here", 0, 4),
			seg("Okay.", 5, 12), // 7s trailing-pause segment, wpm ~8.6 (absurd)
		];
		// Room tone quiet, but the word span [5.2, 5.6] carries real energy.
		const env = envelope(12, 0.05, [5, 12, 0.001], [5.2, 5.6, 0.03]);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		expect(result.hallucinatedSpans).toHaveLength(0);
		expect(result.cleanWords.some((w) => w.text === "Okay.")).toBe(true);
	});

	test("threshold ceiling: with silent screened median the fixed ceiling still applies", () => {
		// All screened segments are themselves quiet: threshold collapses to
		// min(ceiling, tiny) so a hallucinated segment must be QUIETER than
		// the real quiet speech to flag. Here it is (0.0001 vs 0.004).
		const words = [
			...spread("soft spoken real words in a quiet room", 0, 4),
			{ text: "you.", start: 5, end: 25 },
		];
		const segments = [
			seg("soft spoken real words in a quiet room", 0, 4),
			seg("you.", 5, 25),
		];
		const env = envelope(25, 0.004, [5, 25, 0.0001]);
		const result = guardHallucinations({ words, segments, envelope: env, windowSec: WIN });

		expect(result.hallucinatedSpans).toHaveLength(1);
		expect(SILENCE_RMS_CEILING).toBeGreaterThan(0.004 * 0.5);
	});
});
