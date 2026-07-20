import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import type { MediaAsset } from "@/media/types";

/**
 * VibeCut (W7): a "Solid" is a synthetic color media asset - a full-frame
 * color fill with no real source content - that flows through the existing
 * image/mediaId pipeline (MediaAsset, ImageElement) instead of a new
 * TimelineElement variant. `solidColor` on a MediaAsset marks an asset as one;
 * the renderer paints the fill directly (services/renderer/nodes/solid-color-node.ts)
 * and never decodes the placeholder file below - it exists only so every
 * `.file`/`.url` consumer already in the media pipeline (bin sort-by-size,
 * storage persistence, the blur-backdrop gate) keeps working unchanged.
 *
 * Color is per PLACEMENT, not per asset: dragging the same "Solid color" bin
 * item onto the timeline twice gives two elements that both start out
 * showing the asset's color, but editing one (ImageElement.solidColor) never
 * repaints the other. This is a deliberate divergence from Premiere's Color
 * Matte, whose shared-master-asset color is its most-complained-about
 * gotcha (see docs/plans/2026-07-19-003-feat-w4-w7-feature-specs.md "W7").
 */

export const SOLID_COLOR_ASSET_NAME = "Solid color";

const PLACEHOLDER_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#808080"/></svg>';
const PLACEHOLDER_DATA_URL = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

export function isSolidColorAsset({
	asset,
}: {
	asset: { solidColor?: string } | null | undefined;
}): boolean {
	return asset?.solidColor != null;
}

/**
 * The color actually painted for one placed solid: the element's own
 * override if it has been edited, otherwise the asset's color, otherwise the
 * project default. Used by both the renderer (scene-builder.ts) and the
 * Properties panel color picker, so the two never disagree.
 */
export function resolveSolidElementColor({
	element,
	mediaAsset,
}: {
	element: { solidColor?: string };
	mediaAsset: { solidColor?: string } | null | undefined;
}): string {
	return (
		element.solidColor ?? mediaAsset?.solidColor ?? DEFAULT_BACKGROUND_COLOR
	);
}

/**
 * Builds the synthetic media asset a "Solid color" bin action creates. No
 * canvas rendering happens here (and none is needed): the fill is painted
 * dynamically at the project's current canvas size on every frame, so it
 * never goes stale if the canvas size changes later. `width`/`height` below
 * are informational only (bin tooltips, sort), not what the renderer reads.
 */
export function buildSolidColorAsset({
	color = DEFAULT_BACKGROUND_COLOR,
	canvasSize,
	name = SOLID_COLOR_ASSET_NAME,
}: {
	color?: string;
	canvasSize: { width: number; height: number };
	name?: string;
}): Omit<MediaAsset, "id"> {
	const file = new File([PLACEHOLDER_SVG], `${name}.svg`, {
		type: "image/svg+xml",
	});
	return {
		type: "image",
		name,
		file,
		url: PLACEHOLDER_DATA_URL,
		solidColor: color,
		width: canvasSize.width,
		height: canvasSize.height,
	};
}
