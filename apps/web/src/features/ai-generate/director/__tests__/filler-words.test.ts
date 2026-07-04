import { describe, expect, test } from "bun:test";
import { detectFillerCuts } from "../filler-words";
import type { WordTiming } from "../cut-utils";

const w = ([text, start, end]: [string, number, number]): WordTiming => ({
	text,
	start,
	end,
});

describe("detectFillerCuts", () => {
	test("cuts a standalone filler, tagged category 'filler'", () => {
		const ops = detectFillerCuts({
			words: [w(["So,", 0, 0.3]), w(["um", 0.4, 0.6]), w(["yes", 0.7, 1.0])],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			op: "cut",
			startSec: 0.4,
			endSec: 0.6,
			category: "filler",
		});
	});

	test("matches the other disfluencies (uh / er / erm / hmm)", () => {
		for (const f of ["uh", "er", "erm", "hmm"]) {
			const ops = detectFillerCuts({ words: [w([f, 1, 1.2])] });
			expect(ops).toHaveLength(1);
		}
	});

	test("cuts a two-word hedge across both tokens", () => {
		const ops = detectFillerCuts({
			words: [w(["you", 2.0, 2.2]), w(["know", 2.25, 2.5]), w(["the", 2.6, 2.8])],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ startSec: 2.0, endSec: 2.5 });
	});

	test("cuts a cut-off false start (trailing dash)", () => {
		const ops = detectFillerCuts({
			words: [w(["th-", 0, 0.15]), w(["the", 0.2, 0.4]), w(["cat", 0.45, 0.7])],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ startSec: 0, endSec: 0.15 });
		expect(ops[0].reason).toContain("False start");
	});

	test("does NOT cut context-dependent words (so / like / well)", () => {
		const ops = detectFillerCuts({
			words: [w(["so", 0, 0.2]), w(["like", 0.3, 0.5]), w(["well", 0.6, 0.8])],
		});
		expect(ops).toEqual([]);
	});

	test("skips zero-length words", () => {
		expect(detectFillerCuts({ words: [w(["um", 1, 1])] })).toEqual([]);
	});
});
