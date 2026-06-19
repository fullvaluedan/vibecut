import { describe, expect, test } from "bun:test";
import {
	HIGH_SIMILAR,
	SIMILAR,
	contentTokens,
	mostSimilar,
	similarity,
} from "../text-similarity";

describe("similarity", () => {
	test("identical text scores 1.0", () => {
		expect(
			similarity({ a: "we should ship it today", b: "we should ship it today" }),
		).toBeCloseTo(1, 6);
	});

	test("reordered same words score high (order-invariant)", () => {
		const score = similarity({ a: "ship it today we should", b: "we should ship it today" });
		expect(score).toBeGreaterThanOrEqual(HIGH_SIMILAR);
	});

	test("near-verbatim restatement clears the merge threshold", () => {
		// One trailing word added — the far-apart / cross-clip restart case.
		const score = similarity({ a: "we should ship it", b: "we should ship it today" });
		expect(score).toBeGreaterThanOrEqual(HIGH_SIMILAR);
	});

	test("near-verbatim with a dropped stopword still clears the threshold", () => {
		const score = similarity({
			a: "the key thing here is alignment",
			b: "the key thing is alignment",
		});
		expect(score).toBeGreaterThanOrEqual(HIGH_SIMILAR);
	});

	test("fillers are ignored before comparison", () => {
		const score = similarity({ a: "um so we should ship it", b: "so we should ship it" });
		expect(score).toBeGreaterThanOrEqual(HIGH_SIMILAR);
	});

	test("true paraphrase (different words) scores low — NOT this layer's job", () => {
		// Documents the honest limit: lexical does not catch semantic paraphrase.
		const score = similarity({ a: "revenue doubled last quarter", b: "we saw sales jump" });
		expect(score).toBeLessThan(SIMILAR);
	});

	test("two short distinct sentences sharing a word do not falsely merge", () => {
		const score = similarity({ a: "the app crashed", b: "the app froze" });
		expect(score).toBeLessThan(HIGH_SIMILAR);
	});

	test("unrelated sentences score near zero", () => {
		const score = similarity({
			a: "let me show you the timeline",
			b: "subscribe for more videos",
		});
		expect(score).toBeLessThan(SIMILAR);
	});

	test("empty vs non-empty is 0 (no false match against a blank line)", () => {
		expect(similarity({ a: "", b: "we should ship it" })).toBe(0);
	});

	test("both empty is the degenerate 1", () => {
		expect(similarity({ a: "  ", b: "" })).toBe(1);
	});
});

describe("contentTokens", () => {
	test("drops stopwords and fillers, keeps topic words", () => {
		expect([...contentTokens("um so we should ship the app today")]).toEqual([
			"should",
			"ship",
			"app",
			"today",
		]);
	});
});

describe("mostSimilar", () => {
	test("returns the best-scoring candidate and its index", () => {
		const match = mostSimilar({
			target: "we should ship it today",
			candidates: ["totally unrelated line", "we should ship it today as well", "another thing"],
		});
		expect(match).not.toBeNull();
		expect(match?.index).toBe(1);
		expect(match?.score).toBeGreaterThanOrEqual(HIGH_SIMILAR);
	});

	test("null when there are no candidates", () => {
		expect(mostSimilar({ target: "anything", candidates: [] })).toBeNull();
	});
});
