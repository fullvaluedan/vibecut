import { describe, expect, test } from "bun:test";
import { needsWordUpgrade } from "../word-upgrade";

describe("needsWordUpgrade", () => {
	test("a segment-only caller (wantWords false) never upgrades", () => {
		expect(
			needsWordUpgrade({ wantWords: false, result: {} }),
		).toBe(false);
	});

	test("does not upgrade when the joined run already produced words", () => {
		expect(
			needsWordUpgrade({
				wantWords: true,
				result: { words: [{ start: 0, end: 1, text: "hi" }] },
			}),
		).toBe(false);
	});

	test("does not upgrade when the model declared words unavailable", () => {
		expect(
			needsWordUpgrade({
				wantWords: true,
				result: { wordsUnavailable: true },
			}),
		).toBe(false);
	});

	test("upgrades when words are needed but a segment-only run had none", () => {
		// This is the case that previously started a SECOND concurrent extraction
		// instead of running once after the joined run settled.
		expect(needsWordUpgrade({ wantWords: true, result: {} })).toBe(true);
	});
});
