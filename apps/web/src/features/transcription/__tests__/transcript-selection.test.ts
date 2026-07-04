import { describe, expect, test } from "bun:test";
import { normalizeSelection } from "../transcript-selection";

describe("normalizeSelection", () => {
	test("forward drag keeps order", () => {
		expect(
			normalizeSelection({ anchorIndex: 3, focusIndex: 8, granularity: "word" }),
		).toEqual({ startIndex: 3, endIndex: 8, granularity: "word" });
	});

	test("backward drag normalizes to startIndex <= endIndex", () => {
		expect(
			normalizeSelection({ anchorIndex: 8, focusIndex: 3, granularity: "word" }),
		).toEqual({ startIndex: 3, endIndex: 8, granularity: "word" });
	});

	test("single click selects one item", () => {
		expect(
			normalizeSelection({
				anchorIndex: 5,
				focusIndex: 5,
				granularity: "segment",
			}),
		).toEqual({ startIndex: 5, endIndex: 5, granularity: "segment" });
	});
});
