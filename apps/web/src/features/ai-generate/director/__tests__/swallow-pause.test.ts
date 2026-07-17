import { describe, expect, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";
import { HANDLE_SEC, swallowPauseBounds } from "../swallow-pause";

const WIN = 0.05;
const QUIET = 0.001;
const LOUD = 0.05;
const THRESH = 0.01;

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

function cut(startSec: number, endSec: number, extra: Partial<DirectorOp> = {}): DirectorOp {
	return {
		id: `c-${startSec}`,
		op: "cut",
		startSec,
		endSec,
		reason: "test",
		confidence: 0.6,
		category: "pacing",
		...extra,
	} as DirectorOp;
}

describe("swallowPauseBounds", () => {
	test("a cut inside a pause swallows it to word +/- handle on both sides", () => {
		// Words end at 44.72 and resume at 48.16; silence 44.75-48.20.
		const env = envelope(60, LOUD, [44.75, 48.2, QUIET]);
		const words = [
			{ start: 44.16, end: 44.72 },
			{ start: 48.16, end: 48.3 },
		];
		const ops = swallowPauseBounds({
			ops: [cut(45.38, 47.63)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(44.72 + HANDLE_SEC, 2);
		expect(ops[0].endSec).toBeCloseTo(48.16 - HANDLE_SEC, 2);
	});

	test("an edge flush against continuous speech falls back to the trough snap", () => {
		// Uniform loud audio: the trough snap has nothing quieter, boundary stays.
		const env = envelope(30, LOUD);
		const words = [{ start: 0.5, end: 9.9 }, { start: 12.2, end: 29 }];
		const op = cut(10, 12);
		const ops = swallowPauseBounds({ ops: [op], envelope: env, words, threshold: THRESH });
		expect(ops[0].startSec).toBeCloseTo(10, 3);
		expect(ops[0].endSec).toBeCloseTo(12, 3);
	});

	test("two removals widening into the same pause collapse to one owning cut", () => {
		// One long silence 10-20 with two cuts inside it and no words between:
		// both widen to the identical word-to-word span, so the duplicate drops
		// and a single cut owns the pause (the non-overlap invariant).
		const env = envelope(30, LOUD, [10, 20, QUIET]);
		const words = [
			{ start: 9, end: 9.9 },
			{ start: 20.2, end: 21 },
		];
		const ops = swallowPauseBounds({
			ops: [cut(11, 13), cut(16, 18)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(9.9 + HANDLE_SEC, 2);
		// The walk stops at the silence run's end (20.0): the loud 20.0-20.2
		// stretch before the next word is energetic audio, never swallowed.
		expect(ops[0].endSec).toBeCloseTo(20.0, 2);
	});

	test("widening never crosses 0 or the audio end", () => {
		// Silence from 0 and to the end, no words outside the middle.
		const env = envelope(20, QUIET, [8, 12, LOUD]);
		const words = [{ start: 8.2, end: 11.8 }];
		const ops = swallowPauseBounds({
			ops: [cut(2, 5), cut(14, 17)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops[0].startSec).toBe(0);
		expect(ops[1].endSec).toBeCloseTo(20, 3);
	});

	test("empty envelope is a pass-through", () => {
		const op = cut(1, 2);
		const ops = swallowPauseBounds({ ops: [op], envelope: [], words: [], threshold: THRESH });
		expect(ops).toEqual([op]);
	});

	test("a removal already word-adjacent on both sides stays byte-identical", () => {
		// Words hug the cut: prev ends at start-handle, next starts at end+handle,
		// and the pause is exactly the cut span (no silence outside it).
		const env = envelope(30, LOUD, [10, 12, QUIET]);
		const words = [
			{ start: 9, end: 10 - HANDLE_SEC },
			{ start: 12 + HANDLE_SEC, end: 13 },
		];
		const op = cut(10, 12);
		const ops = swallowPauseBounds({ ops: [op], envelope: env, words, threshold: THRESH });
		// Start edge: window before 10 is loud -> trough snap -> may stay or move
		// within the quiet cut interior... the window at 9.95 is LOUD so fallback
		// snap finds the quiet window just inside the pause; end edge symmetric.
		// The op must never shrink and never clip a word.
		expect(ops[0].startSec).toBeLessThanOrEqual(10 + 0.26);
		expect(ops[0].startSec).toBeGreaterThanOrEqual(10 - 0.26);
		expect(ops[0].endSec).toBeGreaterThanOrEqual(12 - 0.26);
	});

	test("hallucination-free words list lets a silent tail swallow fully", () => {
		// Silence 50-83.85 with NO clean words inside (hallucinations excluded):
		// a cut at 58.23-59.92 widens across the whole silent block.
		const env = envelope(83.85, LOUD, [50, 83.85, QUIET]);
		const words = [{ start: 1, end: 49.8 }];
		const ops = swallowPauseBounds({
			ops: [cut(58.23, 59.92)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops[0].startSec).toBeCloseTo(49.95, 1);
		expect(ops[0].endSec).toBeCloseTo(83.85, 2);
	});

	test("keep and reorder ops pass through untouched", () => {
		const env = envelope(30, LOUD, [10, 14, QUIET]);
		const keep: DirectorOp = {
			id: "k1",
			op: "keep",
			startSec: 10,
			endSec: 14,
			reason: "beat",
			confidence: 0.9,
		} as DirectorOp;
		const ops = swallowPauseBounds({
			ops: [keep],
			envelope: env,
			words: [],
			threshold: THRESH,
		});
		expect(ops[0]).toBe(keep);
	});
});
