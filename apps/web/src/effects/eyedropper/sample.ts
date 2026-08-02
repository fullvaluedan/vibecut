/**
 * T19.2 eyedropper: preview-space -> source-pixel mapping, plus the pixel
 * readers the magnifier and the colour pick both use.
 *
 * WHICH FRAME GETS SAMPLED. The picker reads the clip's DECODED SOURCE frame
 * (`videoCache.getFrameAt`, the same call `services/renderer/capture-frame.ts`
 * makes for freeze frame), NOT the composited preview canvas. For a chroma key
 * that is the only correct source: the key has to be told the colour the
 * shader will actually see as its input, and by the time a pixel reaches the
 * preview canvas it has already been through this very effect (so picking
 * green off a screen that is already keying green would sample whatever is
 * BEHIND the subject), plus every other effect on the clip, its opacity, its
 * blend mode, and the layers under it.
 *
 * The cost of sampling the source is that preview coordinates have to be
 * mapped back through the clip's crop and transform by hand, which is what
 * `previewPointToSourcePixel` below does. It mirrors
 * `computeVisualTransform` in services/renderer/compositor/frame-descriptor.ts
 * exactly, including the crop-before-transform order documented in
 * rendering/crop.ts.
 */

import { getCropPixelRect, isNoOpCrop } from "@/rendering/crop";
import type { CropRect } from "@/timeline";

export interface EyedropperTransform {
	scaleX: number;
	scaleY: number;
	position: { x: number; y: number };
	rotate: number;
}

export interface SourcePixelPoint {
	/** Integer pixel column in the DECODED source frame. */
	x: number;
	/** Integer pixel row in the DECODED source frame. */
	y: number;
}

/**
 * Scene-normalized preview point (0..1 across the rendered scene rect) ->
 * source pixel. Returns null when the point misses the clip's quad, so the
 * caller can refuse to sample instead of clamping to a wrong edge pixel.
 */
export function previewPointToSourcePixel({
	point,
	canvasSize,
	sourceSize,
	crop,
	transform,
}: {
	point: { x: number; y: number };
	canvasSize: { width: number; height: number };
	sourceSize: { width: number; height: number };
	crop?: CropRect;
	transform: EyedropperTransform;
}): SourcePixelPoint | null {
	if (
		sourceSize.width <= 0 ||
		sourceSize.height <= 0 ||
		canvasSize.width <= 0 ||
		canvasSize.height <= 0
	) {
		return null;
	}

	// Crop first: everything downstream treats the cropped rect as if it were
	// the source's natural size (rendering/crop.ts).
	const cropRect =
		crop && !isNoOpCrop(crop)
			? getCropPixelRect({
					sourceWidth: sourceSize.width,
					sourceHeight: sourceSize.height,
					crop,
				})
			: { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height };

	const containScale = Math.min(
		canvasSize.width / cropRect.width,
		canvasSize.height / cropRect.height,
	);
	const scaledWidth = cropRect.width * containScale * transform.scaleX;
	const scaledHeight = cropRect.height * containScale * transform.scaleY;
	const absWidth = Math.abs(scaledWidth);
	const absHeight = Math.abs(scaledHeight);
	if (absWidth < 1e-6 || absHeight < 1e-6) {
		return null;
	}

	const centerX = canvasSize.width / 2 + transform.position.x;
	const centerY = canvasSize.height / 2 + transform.position.y;
	const canvasX = point.x * canvasSize.width;
	const canvasY = point.y * canvasSize.height;

	// Un-rotate around the quad centre (the renderer rotates by +rotate, so
	// going the other way is -rotate).
	const radians = (transform.rotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const deltaX = canvasX - centerX;
	const deltaY = canvasY - centerY;
	const localX = deltaX * cos + deltaY * sin;
	const localY = -deltaX * sin + deltaY * cos;

	let u = localX / absWidth + 0.5;
	let v = localY / absHeight + 0.5;
	// A negative scale renders the quad flipped, so the same screen point maps
	// to the mirrored source column/row.
	if (scaledWidth < 0) u = 1 - u;
	if (scaledHeight < 0) v = 1 - v;

	if (u < 0 || u > 1 || v < 0 || v > 1) {
		return null;
	}

	const sourceX = cropRect.x + u * cropRect.width;
	const sourceY = cropRect.y + v * cropRect.height;

	return {
		x: Math.min(sourceSize.width - 1, Math.max(0, Math.floor(sourceX))),
		y: Math.min(sourceSize.height - 1, Math.max(0, Math.floor(sourceY))),
	};
}

function toHexChannel({ value }: { value: number }): string {
	return Math.min(255, Math.max(0, Math.round(value)))
		.toString(16)
		.padStart(2, "0");
}

export function rgbToHex({
	r,
	g,
	b,
}: {
	r: number;
	g: number;
	b: number;
}): string {
	return `#${toHexChannel({ value: r })}${toHexChannel({ value: g })}${toHexChannel({ value: b })}`.toUpperCase();
}

/**
 * One RGBA8 pixel out of an ImageData-shaped buffer. Returns null for an
 * out-of-bounds read rather than reading a neighbouring row's bytes.
 */
export function readPixel({
	data,
	width,
	height,
	x,
	y,
}: {
	data: Uint8ClampedArray | Uint8Array;
	width: number;
	height: number;
	x: number;
	y: number;
}): { r: number; g: number; b: number; a: number } | null {
	if (x < 0 || y < 0 || x >= width || y >= height) {
		return null;
	}
	const offset = (y * width + x) * 4;
	if (offset + 3 >= data.length) {
		return null;
	}
	return {
		r: data[offset],
		g: data[offset + 1],
		b: data[offset + 2],
		a: data[offset + 3],
	};
}

/**
 * Mean colour of the (2 * radius + 1)^2 block around a pixel, clipped to the
 * frame. Radius 0 is the single pixel under the cursor. A small block is what
 * makes picking off compressed 4:2:0 footage land on the real key colour
 * instead of a chroma-subsampling artefact.
 */
export function sampleAverageColor({
	data,
	width,
	height,
	x,
	y,
	radius,
}: {
	data: Uint8ClampedArray | Uint8Array;
	width: number;
	height: number;
	x: number;
	y: number;
	radius: number;
}): { r: number; g: number; b: number } | null {
	let totalR = 0;
	let totalG = 0;
	let totalB = 0;
	let count = 0;

	for (let offsetY = -radius; offsetY <= radius; offsetY++) {
		for (let offsetX = -radius; offsetX <= radius; offsetX++) {
			const pixel = readPixel({
				data,
				width,
				height,
				x: x + offsetX,
				y: y + offsetY,
			});
			if (!pixel) continue;
			totalR += pixel.r;
			totalG += pixel.g;
			totalB += pixel.b;
			count++;
		}
	}

	if (count === 0) {
		return null;
	}
	return {
		r: totalR / count,
		g: totalG / count,
		b: totalB / count,
	};
}

/** Side length, in source pixels, of the magnifier's zoom window. */
export const MAGNIFIER_PIXEL_SPAN = 11;
/** Radius averaged into a single pick. 1 = a 3x3 block. */
export const SAMPLE_RADIUS = 1;
