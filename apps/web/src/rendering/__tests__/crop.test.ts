import { describe, expect, test } from "bun:test";
import {
	NO_CROP,
	clampCropRect,
	getCropPixelRect,
	isNoOpCrop,
} from "@/rendering/crop";

describe("clampCropRect", () => {
	test("clamps each fraction to [0, 1] before the pair cap is applied", () => {
		// left/right and top/bottom individually clamp to [0,1] first; these
		// values stay under the 0.99 pair cap so only the per-field clamp is
		// exercised here (the pair cap has its own tests below).
		expect(clampCropRect({ left: -0.5, top: 0.6, right: -1, bottom: 0.3 })).toEqual(
			{ left: 0, top: 0.6, right: 0, bottom: 0.3 },
		);
	});

	test("NaN/non-finite collapses to 0", () => {
		expect(
			clampCropRect({
				left: Number.NaN,
				top: Number.POSITIVE_INFINITY,
				right: 0,
				bottom: 0,
			}),
		).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
	});

	test("left+right pair is capped so a visible sliver always remains", () => {
		const result = clampCropRect({ left: 0.7, top: 0, right: 0.7, bottom: 0 });
		expect(result.left + result.right).toBeCloseTo(0.99, 5);
		// Ratio between the two edges is preserved (both were equal, so they
		// stay equal after scaling down).
		expect(result.left).toBeCloseTo(result.right, 5);
	});

	test("top+bottom pair is capped independently of left+right", () => {
		const result = clampCropRect({ left: 0.1, top: 0.9, right: 0.1, bottom: 0.9 });
		expect(result.left).toBe(0.1);
		expect(result.right).toBe(0.1);
		expect(result.top + result.bottom).toBeCloseTo(0.99, 5);
	});

	test("a rect within bounds passes through unchanged", () => {
		const rect = { left: 0.1, top: 0.2, right: 0.15, bottom: 0.05 };
		expect(clampCropRect(rect)).toEqual(rect);
	});
});

describe("isNoOpCrop", () => {
	test("undefined and NO_CROP are both no-ops", () => {
		expect(isNoOpCrop(undefined)).toBe(true);
		expect(isNoOpCrop(NO_CROP)).toBe(true);
	});

	test("any positive fraction is not a no-op", () => {
		expect(isNoOpCrop({ left: 0.01, top: 0, right: 0, bottom: 0 })).toBe(false);
	});
});

describe("getCropPixelRect", () => {
	test("computes the pixel sub-rect against the source's own size", () => {
		const rect = getCropPixelRect({
			sourceWidth: 1000,
			sourceHeight: 500,
			crop: { left: 0.1, top: 0.2, right: 0.1, bottom: 0.2 },
		});
		expect(rect).toEqual({ x: 100, y: 100, width: 800, height: 300 });
	});

	test("no crop returns the full source rect", () => {
		const rect = getCropPixelRect({
			sourceWidth: 640,
			sourceHeight: 360,
			crop: NO_CROP,
		});
		expect(rect).toEqual({ x: 0, y: 0, width: 640, height: 360 });
	});

	test("width/height never drop below 1px even for an extreme crop", () => {
		const rect = getCropPixelRect({
			sourceWidth: 10,
			sourceHeight: 10,
			crop: { left: 0.99, top: 0, right: 0, bottom: 0.99 },
		});
		expect(rect.width).toBeGreaterThanOrEqual(1);
		expect(rect.height).toBeGreaterThanOrEqual(1);
	});
});

describe("crop serialization round-trip", () => {
	test("a plain-object crop round-trips through JSON unchanged", () => {
		const crop = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.05 };
		const roundTripped = JSON.parse(JSON.stringify(crop));
		expect(roundTripped).toEqual(crop);
	});
});
