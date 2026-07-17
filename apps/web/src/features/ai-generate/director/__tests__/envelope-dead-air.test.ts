import { describe, expect, test } from "bun:test";
import {
	AUTO_MIN_RUN_SEC,
	computeSilenceRuns,
	computeSilenceThreshold,
	detectEnvelopeDeadAirCuts,
	EDGE_MIN_RUN_SEC,
	KEEP_BEAT_PAD_SEC,
} from "../envelope-dead-air";
import { SILENCE_RMS_CEILING } from "../hallucination-guard";

const WIN = 0.05;
const QUIET = 0.001;
const LOUD = 0.05;

/** Envelope of `seconds` at `base` level with [start,end,level] overrides. */
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

/** Evenly spaced words filling [startSec, endSec). */
function wordsIn(startSec: number, endSec: number, count: number) {
	const step = (endSec - startSec) / count;
	return Array.from({ length: count }, (_, i) => ({
		start: startSec + i * step,
		end: startSec + (i + 1) * step,
	}));
}

const THRESH = 0.01;

describe("computeSilenceThreshold", () => {
	test("caps at the fixed ceiling and adapts to the median", () => {
		expect(computeSilenceThreshold([])).toBeCloseTo(SILENCE_RMS_CEILING, 6);
		expect(computeSilenceThreshold([0.1, 0.2, 0.3])).toBeCloseTo(SILENCE_RMS_CEILING, 6);
		expect(computeSilenceThreshold([0.004, 0.004, 0.004])).toBeCloseTo(0.002, 6);
	});
});

describe("computeSilenceRuns", () => {
	test("finds interior, leading, and trailing runs", () => {
		const env = envelope(10, LOUD, [0, 1, QUIET], [4, 7, QUIET], [9, 10, QUIET]);
		const runs = computeSilenceRuns({ envelope: env, windowSec: WIN, threshold: THRESH });
		expect(runs).toHaveLength(3);
		expect(runs[0].startSec).toBeCloseTo(0, 3);
		expect(runs[0].endSec).toBeCloseTo(1, 3);
		expect(runs[1].startSec).toBeCloseTo(4, 3);
		expect(runs[1].endSec).toBeCloseTo(7, 3);
		expect(runs[2].endSec).toBeCloseTo(10, 3);
	});
});

describe("detectEnvelopeDeadAirCuts", () => {
	test("the live 24s dead-air tail block becomes one padded AUTO cut", () => {
		// Speech 1-57.7, silence 57.7-81.9, blip 81.9-83, silence 83-83.85.
		const env = envelope(83.85, QUIET, [1, 57.7, LOUD], [81.9, 83, LOUD]);
		const words = wordsIn(1, 57.6, 100);
		const ops = detectEnvelopeDeadAirCuts({
			envelope: env,
			windowSec: WIN,
			threshold: THRESH,
			words,
			totalSec: 83.87,
		});
		// Head run 0-1 (edge), the 24.2s interior block, and the trailing 0.85s run.
		expect(ops).toHaveLength(3);
		const interior = ops.find((o) => o.startSec > 50 && o.endSec < 83)!;
		expect(interior.startSec).toBeCloseTo(57.7 + KEEP_BEAT_PAD_SEC, 2);
		expect(interior.endSec).toBeCloseTo(81.9 - KEEP_BEAT_PAD_SEC, 2);
		expect(interior.category).toBe("deadair");
		expect(interior.defaultAccept).toBeUndefined();
		const trailing = ops.find((o) => o.endSec > 83.5)!;
		expect(trailing.endSec).toBeCloseTo(83.87, 3);
	});

	test("the 3.4s inter-sentence pause is cut with a pad on both sides", () => {
		const env = envelope(60, LOUD, [44.76, 48.19, QUIET]);
		const words = [...wordsIn(1, 44.7, 80), ...wordsIn(48.2, 59, 20)];
		const ops = detectEnvelopeDeadAirCuts({
			envelope: env,
			windowSec: WIN,
			threshold: THRESH,
			words,
			totalSec: 60,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(44.75 + KEEP_BEAT_PAD_SEC, 1);
		expect(ops[0].endSec).toBeCloseTo(48.2 - KEEP_BEAT_PAD_SEC, 1);
	});

	test("head silence cuts flush from 0 with the interior side padded", () => {
		const env = envelope(30, LOUD, [0, 0.96, QUIET]);
		const words = wordsIn(1, 29, 50);
		const ops = detectEnvelopeDeadAirCuts({
			envelope: env,
			windowSec: WIN,
			threshold: THRESH,
			words,
			totalSec: 30,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBe(0);
		// The paint helper quantizes 0.96 up to the 1.0s window boundary.
		expect(ops[0].endSec).toBeCloseTo(1.0 - KEEP_BEAT_PAD_SEC, 2);
		expect(EDGE_MIN_RUN_SEC).toBeLessThan(0.96);
	});

	test("a 2.0s interior run is below the AUTO floor: no op", () => {
		const env = envelope(30, LOUD, [10, 12, QUIET]);
		const words = [...wordsIn(1, 9.9, 20), ...wordsIn(12.1, 29, 20)];
		const ops = detectEnvelopeDeadAirCuts({
			envelope: env,
			windowSec: WIN,
			threshold: THRESH,
			words,
			totalSec: 30,
		});
		expect(AUTO_MIN_RUN_SEC).toBeGreaterThan(2.0);
		expect(ops).toHaveLength(0);
	});

	test("a low-energy run holding a real word midpoint is ineligible", () => {
		const env = envelope(30, LOUD, [10, 14, QUIET]);
		const words = [...wordsIn(1, 9.9, 20), { start: 11.5, end: 12.0 }, ...wordsIn(14.1, 29, 20)];
		const ops = detectEnvelopeDeadAirCuts({
			envelope: env,
			windowSec: WIN,
			threshold: THRESH,
			words,
			totalSec: 30,
		});
		expect(ops).toHaveLength(0);
	});

	test("whole-timeline silence stays an opt-in row (fraction guard)", () => {
		const env = envelope(60, QUIET);
		const ops = detectEnvelopeDeadAirCuts({
			envelope: env,
			windowSec: WIN,
			threshold: THRESH,
			words: [],
			totalSec: 60,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(false);
	});

	test("empty envelope: no ops", () => {
		expect(
			detectEnvelopeDeadAirCuts({
				envelope: [],
				windowSec: WIN,
				threshold: THRESH,
				words: [],
				totalSec: 60,
			}),
		).toHaveLength(0);
	});

	test("a timeline far longer than the audio keeps tail runs interior", () => {
		// Audio ends at 30s but the timeline runs to 120s: the 26-30s run must
		// NOT cut flush to 120 (the envelope says nothing about 30-120).
		const env = envelope(30, LOUD, [26, 30, QUIET]);
		const words = wordsIn(1, 25.9, 40);
		const ops = detectEnvelopeDeadAirCuts({
			envelope: env,
			windowSec: WIN,
			threshold: THRESH,
			words,
			totalSec: 120,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].endSec).toBeCloseTo(30 - KEEP_BEAT_PAD_SEC, 2);
	});
});
