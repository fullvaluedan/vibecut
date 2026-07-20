import { describe, expect, test } from "bun:test";
import { clampSliderNumberValue } from "@/components/ui/slider-number-pair";

/**
 * W6 R4: SliderNumberPair couples a Radix slider and a NumberField to one
 * onPreview/onCommit contract. The "pairing" is that BOTH halves resolve a
 * proposed value through this one pure function, so a slider drag and a
 * typed number always converge on the identical result, no DOM needed to
 * verify that (this repo's `bun test` has no DOM; see other __tests__).
 */
describe("clampSliderNumberValue", () => {
	test("slider and number inputs converge on the same value", () => {
		const fromSlider = clampSliderNumberValue({ value: 50, min: 0, max: 100, step: 1 });
		const fromNumber = clampSliderNumberValue({ value: 50, min: 0, max: 100, step: 1 });
		expect(fromSlider).toBe(fromNumber);
		expect(fromSlider).toBe(50);
	});

	test("clamps below min regardless of source", () => {
		expect(clampSliderNumberValue({ value: -20, min: 0, max: 100, step: 1 })).toBe(0);
	});

	test("clamps above max regardless of source", () => {
		expect(clampSliderNumberValue({ value: 150, min: 0, max: 100, step: 1 })).toBe(100);
	});

	test("snaps to the step grid before clamping: a typed value off-grid lands where a slider drag would", () => {
		// step 10: a slider can only ever land on 0/10/20/...; a typed "53" must
		// resolve to the same 50 a slider drag would produce.
		expect(clampSliderNumberValue({ value: 53, min: 0, max: 100, step: 10 })).toBe(50);
	});

	test("negative ranges (e.g. volume dB) clamp correctly in both directions", () => {
		expect(clampSliderNumberValue({ value: -100, min: -60, max: 20, step: 0.01 })).toBe(-60);
		expect(clampSliderNumberValue({ value: 100, min: -60, max: 20, step: 0.01 })).toBe(20);
		expect(clampSliderNumberValue({ value: -5, min: -60, max: 20, step: 0.01 })).toBe(-5);
	});
});
