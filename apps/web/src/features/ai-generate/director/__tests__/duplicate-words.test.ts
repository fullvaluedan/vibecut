import { describe, expect, test } from "bun:test";
import { detectDuplicateWordCuts, type DupWord } from "../duplicate-words";

const w = ([text, start, end]: [string, number, number]): DupWord => ({
	text,
	start,
	end,
});

describe("detectDuplicateWordCuts", () => {
	test("flags an adjacent doubled word, cutting the SECOND occurrence", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["and", 1.0, 1.2]), w(["now", 1.25, 1.45]), w(["now", 1.5, 1.7])],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({
			op: "cut",
			startSec: 1.5,
			endSec: 1.7,
			category: "duplicate",
		});
		expect(ops[0].reason).toContain("now");
	});

	test("distinct adjacent words yield nothing", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["the", 0, 0.2]), w(["cat", 0.25, 0.5]), w(["sat", 0.55, 0.8])],
		});
		expect(ops).toEqual([]);
	});

	test("matches across case + surrounding punctuation", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["Now,", 2.0, 2.2]), w(["now.", 2.25, 2.45])],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ startSec: 2.25, endSec: 2.45 });
	});

	test("a gap larger than the threshold is a pause, not a stumble", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["wait", 0, 0.3]), w(["wait", 1.5, 1.8])],
		});
		expect(ops).toEqual([]);
	});

	test("steps over a single breath/filler between the repeats", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["now", 1.0, 1.2]), w(["uh", 1.25, 1.35]), w(["now", 1.4, 1.6])],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ startSec: 1.4, endSec: 1.6 });
	});

	test("a non-filler word between the repeats is NOT skipped", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["now", 0, 0.2]), w(["you", 0.25, 0.4]), w(["now", 0.45, 0.65])],
		});
		expect(ops).toEqual([]);
	});

	test("a re-articulation pause up to ~1s is still caught (lower confidence)", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["pizza", 0, 0.3]), w(["pizza", 0.9, 1.2])],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].confidence).toBe(0.6);
	});

	test("a triple keeps one and cuts the two extras", () => {
		const intentional = detectDuplicateWordCuts({
			words: [w(["really", 0, 0.3]), w(["really", 0.32, 0.6]), w(["really", 0.62, 0.9])],
		});
		// "really" is intentional-double allow-listed → still skipped.
		expect(intentional).toEqual([]);

		const stumble = detectDuplicateWordCuts({
			words: [w(["just", 0, 0.3]), w(["just", 0.32, 0.6]), w(["just", 0.62, 0.9])],
		});
		expect(stumble.map((o) => o.startSec)).toEqual([0.32, 0.62]);
	});

	test("intentional doubles (no / yeah / very) are skipped", () => {
		for (const word of ["no", "yeah", "very"]) {
			const ops = detectDuplicateWordCuts({
				words: [w([word, 0, 0.2]), w([word, 0.25, 0.45])],
			});
			expect(ops).toEqual([]);
		}
	});

	test("single-letter repeats are too noisy to flag", () => {
		const ops = detectDuplicateWordCuts({
			words: [w(["a", 0, 0.1]), w(["a", 0.12, 0.22])],
		});
		expect(ops).toEqual([]);
	});

	test("stable id is deterministic for the same span", () => {
		const words = [w(["so", 0, 0.2]), w(["test", 0.5, 0.7]), w(["test", 0.75, 0.95])];
		const a = detectDuplicateWordCuts({ words });
		const b = detectDuplicateWordCuts({ words });
		expect(a[0].id).toBe(b[0].id);
		expect(a[0].id.startsWith("dup-")).toBe(true);
	});
});
