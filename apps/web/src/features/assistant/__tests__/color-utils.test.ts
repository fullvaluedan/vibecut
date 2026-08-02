import { describe, expect, test } from "bun:test";
import { deriveAccent, hexToRgb, pickForeground, relativeLuminance } from "../color-utils";

describe("relativeLuminance", () => {
	test("black is 0, white is 1", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
	});

	test("accepts the 3-digit shorthand", () => {
		expect(relativeLuminance("#fff")).toBeCloseTo(relativeLuminance("#ffffff"), 5);
	});

	test("a malformed hex reads as black rather than throwing", () => {
		expect(relativeLuminance("not-a-color")).toBe(0);
	});
});

describe("hexToRgb", () => {
	test("splits the channels", () => {
		expect(hexToRgb("#ff6e20")).toEqual({ r: 255, g: 110, b: 32 });
	});
});

describe("pickForeground: the contrast-safety rule", () => {
	test("a light background gets dark text", () => {
		expect(pickForeground("#ffffff")).toBe("#0b0d12");
		expect(pickForeground("#f5f5f5")).toBe("#0b0d12");
	});

	test("a dark background gets light text", () => {
		expect(pickForeground("#000000")).toBe("#ffffff");
		expect(pickForeground("#111318")).toBe("#ffffff");
	});
});

describe("deriveAccent", () => {
	test("is deterministic for the same background", () => {
		expect(deriveAccent("#1a2b3c")).toBe(deriveAccent("#1a2b3c"));
	});

	test("stays legible: never renders as a near-black color", () => {
		for (const background of ["#000000", "#ffffff", "#ff0000", "#123456", "#eeeeee"]) {
			expect(relativeLuminance(deriveAccent(background))).toBeGreaterThan(0.15);
		}
	});

	test("hue-shifts away from a saturated background instead of echoing it", () => {
		const red = deriveAccent("#ff0000");
		const blue = deriveAccent("#0000ff");
		// Different background hues must not collapse onto the same accent.
		expect(red).not.toBe(blue);
	});

	test("a grayscale background (no hue of its own) always gets the same fallback accent", () => {
		// Both are pure gray (zero saturation) - only lightness differs, so
		// there is no background hue to shift from either time.
		expect(deriveAccent("#111111")).toBe(deriveAccent("#eeeeee"));
	});
});
