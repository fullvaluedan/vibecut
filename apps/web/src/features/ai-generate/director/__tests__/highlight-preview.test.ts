import { describe, expect, test } from "bun:test";
import { formatHighlightPreview, removedPercent } from "../highlight-preview";

describe("formatHighlightPreview", () => {
	test("formats the keeping/removing summary", () => {
		expect(
			formatHighlightPreview({ keptCount: 6, totalCount: 40, keptSec: 58, totalSec: 1240 }),
		).toBe("keeping 6 of 40 · 58.0s of 1240.0s (−95%)");
	});

	test("keep-everything reads −0%", () => {
		expect(
			formatHighlightPreview({ keptCount: 12, totalCount: 12, keptSec: 100, totalSec: 100 }),
		).toBe("keeping 12 of 12 · 100.0s of 100.0s (−0%)");
	});

	test("keep-nothing reads −100%", () => {
		expect(
			formatHighlightPreview({ keptCount: 0, totalCount: 40, keptSec: 0, totalSec: 1240 }),
		).toContain("(−100%)");
	});
});

describe("removedPercent", () => {
	test("clamps and rounds", () => {
		expect(removedPercent({ keptSec: 58, totalSec: 1240 })).toBe(95);
		expect(removedPercent({ keptSec: 100, totalSec: 100 })).toBe(0);
		expect(removedPercent({ keptSec: 0, totalSec: 100 })).toBe(100);
	});

	test("zero total is 0% (no divide-by-zero)", () => {
		expect(removedPercent({ keptSec: 0, totalSec: 0 })).toBe(0);
	});
});
