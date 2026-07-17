import { describe, expect, test } from "bun:test";
import { mergeDetectedCuts, normalizeWord, stripWordsFromRemoval } from "../cut-utils";
import type { DirectorOp } from "@framecut/hf-bridge";

const op = (
	over: Partial<DirectorOp> & { startSec: number; endSec: number },
): DirectorOp => ({
	id: `id-${over.startSec}`,
	op: "cut",
	reason: "r",
	confidence: 0.8,
	...over,
});

describe("mergeDetectedCuts", () => {
	test("drops a detected cut that overlaps an existing removal", () => {
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 1, endSec: 5 })],
			extraOps: [op({ startSec: 2, endSec: 2.3, id: "x" })],
		});
		expect(merged).toHaveLength(1);
		expect(merged[0].startSec).toBe(1);
	});

	test("keeps a non-overlapping detected cut and sorts by time", () => {
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 10, endSec: 12 })],
			extraOps: [op({ startSec: 3, endSec: 3.3, id: "y" })],
		});
		expect(merged.map((o) => o.startSec)).toEqual([3, 10]);
	});

	test("a 'keep'/'reorder' op does not suppress a detected cut", () => {
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 2, endSec: 8, op: "keep" })],
			extraOps: [op({ startSec: 4, endSec: 4.2, id: "z" })],
		});
		expect(merged).toHaveLength(2);
	});
});

describe("normalizeWord", () => {
	test("lowercases + strips surrounding punctuation, keeps inner apostrophes", () => {
		expect(normalizeWord("  Now,")).toBe("now");
		expect(normalizeWord("don't.")).toBe("don't");
		expect(normalizeWord("—uh—")).toBe("uh");
	});
});

describe("stripWordsFromRemoval", () => {
	const w = (text: string, start: number, end: number) => ({ text, start, end });

	test("live sp- bug shape: a 3.75s pacing span containing a sentence splits word-free", () => {
		// The 2026-07-17 live bug: sp- op 41.63-45.38 engulfing the sentence
		// words 42.34-44.72. The guard splits it into the two word-free gaps.
		const sentence = [
			w("I", 42.34, 42.48),
			w("don't", 42.48, 42.62),
			w("think", 42.62, 42.76),
			w("you", 42.76, 42.86),
			w("even", 42.86, 43.02),
			w("have", 43.02, 43.14),
			w("to", 43.14, 43.28),
			w("link", 43.28, 43.52),
			w("to", 43.52, 43.76),
			w("your", 43.76, 43.88),
			w("Google", 43.88, 44.16),
			w("accounts.", 44.16, 44.72),
		];
		const fragments = stripWordsFromRemoval({
			op: op({ startSec: 41.63, endSec: 45.38, id: "sp-live", category: "pacing" }),
			words: sentence,
		});
		expect(fragments).toHaveLength(2);
		expect(fragments[0].startSec).toBeCloseTo(41.63, 3);
		expect(fragments[0].endSec).toBeCloseTo(42.34, 3);
		expect(fragments[1].startSec).toBeCloseTo(44.72, 3);
		expect(fragments[1].endSec).toBeCloseTo(45.38, 3);
		// No fragment contains any word midpoint.
		for (const f of fragments) {
			for (const word of sentence) {
				const mid = (word.start + word.end) / 2;
				expect(mid >= f.startSec && mid < f.endSec).toBe(false);
			}
		}
		// Fragment ids extend the original so sp- prefix consumers still match.
		expect(fragments[0].id.startsWith("sp-live.")).toBe(true);
	});

	test("a removal with no contained word midpoint returns byte-identical [op]", () => {
		const original = op({ startSec: 10, endSec: 12, id: "pac-x", category: "pacing" });
		const result = stripWordsFromRemoval({
			op: original,
			words: [w("before", 9, 9.9), w("after", 12.1, 12.5)],
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(original);
	});

	test("a sub-0.2s fragment is dropped", () => {
		// Word 10.1-11.9 inside cut 10-12: fragments 0.1s and 0.1s, both dropped.
		const result = stripWordsFromRemoval({
			op: op({ startSec: 10, endSec: 12, id: "pac-y", category: "pacing" }),
			words: [w("held", 10.1, 11.9)],
		});
		expect(result).toHaveLength(0);
	});

	test("empty words is fail-open; keep/reorder pass through", () => {
		const original = op({ startSec: 1, endSec: 5, id: "pac-z" });
		expect(stripWordsFromRemoval({ op: original, words: [] })[0]).toBe(original);
		const keep = op({ startSec: 1, endSec: 5, op: "keep", id: "k" });
		expect(stripWordsFromRemoval({ op: keep, words: [w("x", 2, 3)] })[0]).toBe(keep);
	});

	test("overlapping whisper-artifact words advance the cursor monotonically", () => {
		const result = stripWordsFromRemoval({
			op: op({ startSec: 0, endSec: 6, id: "pac-o", category: "pacing" }),
			words: [w("a", 1, 3), w("b", 2, 2.5)],
		});
		// Word-free spans: [0,1] and [3,6].
		expect(result).toHaveLength(2);
		expect(result[0].endSec).toBeCloseTo(1, 3);
		expect(result[1].startSec).toBeCloseTo(3, 3);
	});
});
