import { describe, expect, it } from "bun:test";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import {
	SOLID_COLOR_ASSET_NAME,
	buildSolidColorAsset,
	isSolidColorAsset,
	resolveSolidElementColor,
} from "@/media/solid-color";

/**
 * W7: pure pieces of the "Solid color" feature (synthetic asset creation,
 * default resolution/duration/color, per-instance color independence). The
 * actual paint (SolidColorNode, a wgpu texture upload) is browser/GPU-only
 * and out of reach of `bun test` - see the render node file for that seam.
 */
describe("buildSolidColorAsset", () => {
	it("defaults to the project background color, canvas-size fill, and no set duration", () => {
		const asset = buildSolidColorAsset({
			canvasSize: { width: 1920, height: 1080 },
		});

		expect(asset.type).toBe("image");
		expect(asset.name).toBe(SOLID_COLOR_ASSET_NAME);
		expect(asset.solidColor).toBe(DEFAULT_BACKGROUND_COLOR);
		expect(asset.width).toBe(1920);
		expect(asset.height).toBe(1080);
		// Left unset on purpose: insertMediaAsset() falls back to
		// DEFAULT_NEW_ELEMENT_DURATION for any still (the same path a normal
		// still image with no natural duration already takes).
		expect(asset.duration).toBeUndefined();
	});

	it("accepts an explicit color and name", () => {
		const asset = buildSolidColorAsset({
			color: "#FF0000",
			canvasSize: { width: 1080, height: 1920 },
			name: "Red backdrop",
		});

		expect(asset.solidColor).toBe("#FF0000");
		expect(asset.name).toBe("Red backdrop");
		expect(asset.width).toBe(1080);
		expect(asset.height).toBe(1920);
	});

	it("always carries a real File so every existing .file consumer keeps working", () => {
		const asset = buildSolidColorAsset({
			canvasSize: { width: 640, height: 360 },
		});

		expect(asset.file).toBeInstanceOf(File);
		expect(asset.file.size).toBeGreaterThan(0);
		expect(asset.url).toBeTruthy();
	});

	it("scales to whatever canvas size is passed in (vertical, square, ...)", () => {
		const vertical = buildSolidColorAsset({
			canvasSize: { width: 1080, height: 1920 },
		});
		const square = buildSolidColorAsset({ canvasSize: { width: 500, height: 500 } });

		expect(vertical.width).toBe(1080);
		expect(vertical.height).toBe(1920);
		expect(square.width).toBe(500);
		expect(square.height).toBe(500);
	});
});

describe("isSolidColorAsset", () => {
	it("is true only when solidColor is set", () => {
		expect(isSolidColorAsset({ asset: { solidColor: "#000000" } })).toBe(true);
		expect(isSolidColorAsset({ asset: { solidColor: undefined } })).toBe(false);
		expect(isSolidColorAsset({ asset: undefined })).toBe(false);
		expect(isSolidColorAsset({ asset: null })).toBe(false);
	});
});

describe("resolveSolidElementColor (per-instance color independence)", () => {
	it("falls back to the asset's color when the element has no override", () => {
		const color = resolveSolidElementColor({
			element: {},
			mediaAsset: { solidColor: "#00FF00" },
		});
		expect(color).toBe("#00FF00");
	});

	it("falls back to the project default when neither element nor asset has a color", () => {
		const color = resolveSolidElementColor({ element: {}, mediaAsset: undefined });
		expect(color).toBe(DEFAULT_BACKGROUND_COLOR);
	});

	it("prefers the element's own color over the shared asset's color", () => {
		const mediaAsset = { solidColor: "#00FF00" };

		const untouched = resolveSolidElementColor({ element: {}, mediaAsset });
		const edited = resolveSolidElementColor({
			element: { solidColor: "#FF00FF" },
			mediaAsset,
		});

		expect(untouched).toBe("#00FF00");
		expect(edited).toBe("#FF00FF");
	});

	it("two elements sharing one asset stay independent once one is edited", () => {
		// Simulates dragging the same "Solid color" bin item onto the timeline
		// twice, then recoloring only the second placement.
		const mediaAsset = { solidColor: "#0000FF" };
		const placementA: { solidColor?: string } = {};
		const placementB: { solidColor?: string } = {};

		// Both start out showing the asset's color.
		expect(resolveSolidElementColor({ element: placementA, mediaAsset })).toBe(
			"#0000FF",
		);
		expect(resolveSolidElementColor({ element: placementB, mediaAsset })).toBe(
			"#0000FF",
		);

		// Editing B's color must not repaint A (the deliberate anti-Premiere
		// divergence: no shared-master-asset "change one, every instance
		// repaints" gotcha).
		placementB.solidColor = "#FFFF00";
		expect(resolveSolidElementColor({ element: placementA, mediaAsset })).toBe(
			"#0000FF",
		);
		expect(resolveSolidElementColor({ element: placementB, mediaAsset })).toBe(
			"#FFFF00",
		);
	});
});
