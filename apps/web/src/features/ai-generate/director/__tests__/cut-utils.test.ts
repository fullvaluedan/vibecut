import { describe, expect, test } from "bun:test";
import { mergeDetectedCuts, normalizeWord } from "../cut-utils";
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
