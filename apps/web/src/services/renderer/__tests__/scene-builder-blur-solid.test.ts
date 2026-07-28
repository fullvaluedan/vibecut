import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { ImageElement, SceneTracks, VideoTrack } from "@/timeline";
import type { TBackground, TCanvasSize } from "@/project/types";
import { buildScene } from "../scene-builder";
import { SolidColorNode } from "../nodes/solid-color-node";
import { BlurBackgroundNode } from "../nodes/blur-background-node";

const CANVAS: TCanvasSize = { width: 1920, height: 1080 };
const BLUR: TBackground = { type: "blur", blurIntensity: 50 };

function solidAsset({
	id,
	color,
}: {
	id: string;
	color: string;
}): MediaAsset {
	return {
		id,
		type: "image",
		name: "Solid color",
		file: new File(["<svg/>"], "solid.svg", { type: "image/svg+xml" }),
		url: "data:image/svg+xml,placeholder",
		solidColor: color,
		width: CANVAS.width,
		height: CANVAS.height,
	} as unknown as MediaAsset;
}

function imageAsset({ id }: { id: string }): MediaAsset {
	return {
		id,
		type: "image",
		name: "photo",
		file: new File(["bytes"], "photo.png", { type: "image/png" }),
		url: "blob:photo",
		width: 640,
		height: 480,
	} as unknown as MediaAsset;
}

function imageElement({
	id,
	mediaId,
	solidColor,
}: {
	id: string;
	mediaId: string;
	solidColor?: string;
}): ImageElement {
	return {
		id,
		type: "image",
		name: id,
		mediaId,
		startTime: 0,
		duration: 120_000,
		trimStart: 0,
		trimEnd: 0,
		params: {},
		...(solidColor ? { solidColor } : {}),
	} as unknown as ImageElement;
}

function mainTrackScene({ element }: { element: ImageElement }): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		elements: [element],
		muted: false,
		hidden: false,
	} as unknown as VideoTrack;
	return { overlay: [], main, audio: [] };
}

function build({
	element,
	mediaAssets,
}: {
	element: ImageElement;
	mediaAssets: MediaAsset[];
}) {
	return buildScene({
		canvasSize: CANVAS,
		tracks: mainTrackScene({ element }),
		mediaAssets,
		duration: 120_000,
		background: BLUR,
	});
}

describe("buildScene blur backdrop for a Solid on the main track", () => {
	test("a solid under a blur background paints its color, never a decoded backdrop", () => {
		const element = imageElement({ id: "e1", mediaId: "s1" });
		const root = build({ element, mediaAssets: [solidAsset({ id: "s1", color: "#ff0000" })] });

		// No BlurBackgroundNode: the placeholder SVG is never decoded into a gray backdrop.
		expect(root.children.some((n) => n instanceof BlurBackgroundNode)).toBe(false);

		// The backdrop is added first, so it is the bottom child - a full-frame
		// SolidColorNode carrying the solid's color.
		const backdrop = root.children[0];
		expect(backdrop).toBeInstanceOf(SolidColorNode);
		expect((backdrop as SolidColorNode).params.color).toBe("#ff0000");
	});

	test("the backdrop honors the element's per-instance color override", () => {
		const element = imageElement({ id: "e1", mediaId: "s1", solidColor: "#00ff00" });
		const root = build({ element, mediaAssets: [solidAsset({ id: "s1", color: "#ff0000" })] });

		const backdrop = root.children[0];
		expect(backdrop).toBeInstanceOf(SolidColorNode);
		// element.solidColor wins over the asset's fallback color.
		expect((backdrop as SolidColorNode).params.color).toBe("#00ff00");
	});

	test("a normal image under a blur background still gets a BlurBackgroundNode", () => {
		const element = imageElement({ id: "e1", mediaId: "img1" });
		const root = build({ element, mediaAssets: [imageAsset({ id: "img1" })] });

		expect(root.children[0]).toBeInstanceOf(BlurBackgroundNode);
		expect(root.children.some((n) => n instanceof SolidColorNode)).toBe(false);
	});
});
