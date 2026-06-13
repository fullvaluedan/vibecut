/**
 * The ONE definition of where an AI/registry-block overlay (alpha WebM) lands
 * on the canvas. VP9-alpha overlays bypass the WebCodecs compositor (it can't
 * decode alpha), so they're drawn by the DOM overlay layer in preview and by
 * ffmpeg at export — and BOTH must reproduce the compositor's transform exactly
 * or the preview won't match the export. This mirrors `computeVisualTransform`
 * in services/renderer/compositor/frame-descriptor.ts: contain-fit the media
 * into the canvas first, then apply the element's scale, centered at the
 * canvas center plus the element's (center-relative) position.
 */

import type { ParamValues } from "@/params";
import type { ElementAnimations } from "@/animation/types";
import { buildTransformFromParams, readOpacityFromParams } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";

export interface OverlayRect {
	/** Top-left + size, in CANVAS pixels. */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Degrees, about the element center. */
	rotation: number;
	flipX: boolean;
	flipY: boolean;
	opacity: number;
}

export function computeOverlayRect({
	params,
	animations,
	localTimeTicks,
	mediaW,
	mediaH,
	canvasW,
	canvasH,
}: {
	params: ParamValues;
	animations: ElementAnimations | undefined;
	/** Element-local time (MediaTime ticks). Only matters for animated overlays. */
	localTimeTicks: number;
	mediaW: number;
	mediaH: number;
	canvasW: number;
	canvasH: number;
}): OverlayRect {
	const transform = resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params }),
		animations,
		localTime: localTimeTicks,
	});
	// Guard against a missing/zero intrinsic size — fall back to full-frame.
	const sw = mediaW > 0 ? mediaW : canvasW;
	const sh = mediaH > 0 ? mediaH : canvasH;
	const containScale = Math.min(canvasW / sw, canvasH / sh);
	const scaledW = sw * containScale * transform.scaleX;
	const scaledH = sh * containScale * transform.scaleY;
	const w = Math.abs(scaledW);
	const h = Math.abs(scaledH);
	const centerX = canvasW / 2 + transform.position.x;
	const centerY = canvasH / 2 + transform.position.y;
	return {
		x: centerX - w / 2,
		y: centerY - h / 2,
		w,
		h,
		rotation: transform.rotate,
		flipX: scaledW < 0,
		flipY: scaledH < 0,
		opacity: readOpacityFromParams({ params }),
	};
}
