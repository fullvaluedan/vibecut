import { describe, expect, test } from "bun:test";
import type { StickerElement, SceneTracks, VideoTrack } from "@/timeline";
import type { TBackground, TCanvasSize } from "@/project/types";
import { resolveStickerId } from "@/stickers/resolver";
import { buildScene } from "@/services/renderer/scene-builder";
import { StickerNode } from "@/services/renderer/nodes/sticker-node";

// T19.4a stickers prune (LEGACY-PROJECT PROOF): index.ts (the 317-line
// browse/search API), categories.ts, providers/logos.ts, providers/shapes.ts,
// and the browse/search half of providers/flags.ts were all deleted as dead
// code. This is the load-bearing half that survived the prune: a project
// saved before the prune can still contain a `flags:us` sticker element, and
// it must keep resolving its URL, rendering through the scene-builder into a
// StickerNode, and producing the same thumbnail URL the timeline clip
// renders - end to end, with only resolver.ts + registry.ts + sticker-id.ts +
// the trimmed providers/flags.ts + providers/index.ts left in the tree.

const CANVAS: TCanvasSize = { width: 1920, height: 1080 };
const SOLID_BACKGROUND: TBackground = { type: "color", color: "#000000" };

function legacyFlagStickerElement(): StickerElement {
	return {
		id: "sticker-1",
		type: "sticker",
		name: "US flag",
		stickerId: "flags:us",
		intrinsicWidth: 512,
		intrinsicHeight: 512,
		startTime: 0,
		duration: 120_000,
		trimStart: 0,
		trimEnd: 0,
		params: {},
	} as unknown as StickerElement;
}

function mainTrackScene({ element }: { element: StickerElement }): SceneTracks {
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

describe("legacy sticker element (flags provider) survives the T19.4a prune", () => {
	test("resolveStickerId still resolves a flags:<code> ID to a URL (the resolver spine)", () => {
		const url = resolveStickerId({ stickerId: "flags:us" });
		expect(url).toBe("/flags/us.svg");
	});

	test("resolveStickerId normalizes case the same way the pre-prune provider did", () => {
		expect(resolveStickerId({ stickerId: "flags:US" })).toBe("/flags/us.svg");
	});

	test("buildScene renders a legacy sticker element into a StickerNode carrying its stickerId", () => {
		const element = legacyFlagStickerElement();
		const root = buildScene({
			canvasSize: CANVAS,
			tracks: mainTrackScene({ element }),
			mediaAssets: [],
			duration: 120_000,
			background: SOLID_BACKGROUND,
		});

		const stickerNode = root.children.find((n) => n instanceof StickerNode) as
			| StickerNode
			| undefined;
		expect(stickerNode).toBeInstanceOf(StickerNode);
		expect(stickerNode?.params.stickerId).toBe("flags:us");
		expect(stickerNode?.params.intrinsicWidth).toBe(512);
		expect(stickerNode?.params.intrinsicHeight).toBe(512);
	});

	test("the timeline clip thumbnail's exact resolveStickerId call shape (20x20 preview) still resolves", () => {
		// Mirrors the call in timeline/components/timeline-element.tsx's
		// StickerElementContent: resolveStickerId({stickerId, options: {width,
		// height}}) feeds the clip's thumbnail <Image src>. flags' resolveUrl
		// ignores width/height (a static SVG path) but must not throw now that
		// it no longer has search/browse siblings in the same module.
		const thumbnailSrc = resolveStickerId({
			stickerId: "flags:us",
			options: { width: 20, height: 20 },
		});
		expect(thumbnailSrc).toBe("/flags/us.svg");
	});

	test("an unknown provider id still throws a clear error (no silent fallback)", () => {
		expect(() => resolveStickerId({ stickerId: "logos:acme" })).toThrow();
	});
});
