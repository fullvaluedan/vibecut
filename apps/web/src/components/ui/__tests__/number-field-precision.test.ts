import { describe, expect, test } from "bun:test";
import { getScrubPrecisionMultiplier } from "@/components/ui/number-field";

/**
 * W6 R5: live scrub precision modifiers, read from the pointer-move event
 * every frame. Ctrl = fine (1/10), Shift = coarse (10x), neither = base rate.
 */
describe("getScrubPrecisionMultiplier", () => {
	test("no modifiers: base rate", () => {
		expect(getScrubPrecisionMultiplier({ ctrlKey: false, shiftKey: false })).toBe(1);
	});

	test("Ctrl held: fine (1/10)", () => {
		expect(getScrubPrecisionMultiplier({ ctrlKey: true, shiftKey: false })).toBe(0.1);
	});

	test("Shift held: coarse (10x)", () => {
		expect(getScrubPrecisionMultiplier({ ctrlKey: false, shiftKey: true })).toBe(10);
	});

	test("both held: Ctrl (fine) takes precedence", () => {
		expect(getScrubPrecisionMultiplier({ ctrlKey: true, shiftKey: true })).toBe(0.1);
	});
});
