import type { CropRect } from "@/timeline";

/**
 * T18.1 crop: fractions are clamped to [0, 1] individually, then left/right
 * and top/bottom pairs are clamped so they never consume the whole source
 * (each pair sums to at most 0.99, leaving a visible sliver) - a crop that
 * ate 100% of a dimension would divide by zero downstream in
 * `getCropPixelRect`.
 */
const MAX_PAIR_SUM = 0.99;

function clampFraction(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function clampPair({
	a,
	b,
}: {
	a: number;
	b: number;
}): { a: number; b: number } {
	const clampedA = clampFraction(a);
	const clampedB = clampFraction(b);
	const sum = clampedA + clampedB;
	if (sum <= MAX_PAIR_SUM) {
		return { a: clampedA, b: clampedB };
	}
	// Scale both down proportionally so the pair still sums to the cap,
	// preserving the ratio the user set between the two edges.
	const scale = sum === 0 ? 0 : MAX_PAIR_SUM / sum;
	return { a: clampedA * scale, b: clampedB * scale };
}

export function clampCropRect(crop: CropRect): CropRect {
	const { a: left, b: right } = clampPair({ a: crop.left, b: crop.right });
	const { a: top, b: bottom } = clampPair({ a: crop.top, b: crop.bottom });
	return { left, top, right, bottom };
}

export const NO_CROP: CropRect = { left: 0, top: 0, right: 0, bottom: 0 };

export function isNoOpCrop(crop: CropRect | undefined): boolean {
	if (!crop) return true;
	const clamped = clampCropRect(crop);
	return (
		clamped.left === 0 &&
		clamped.top === 0 &&
		clamped.right === 0 &&
		clamped.bottom === 0
	);
}

export interface CropPixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Fractions -> pixel rect against the SOURCE's own natural size. Crop is
 * applied before transform/scale (standard video-editor order): the caller
 * crops the decoded frame/image first, then everything downstream (contain
 * scale, position, rotation) operates on the cropped dimensions as if that
 * were the source's natural size.
 */
export function getCropPixelRect({
	sourceWidth,
	sourceHeight,
	crop,
}: {
	sourceWidth: number;
	sourceHeight: number;
	crop: CropRect;
}): CropPixelRect {
	const clamped = clampCropRect(crop);
	const x = Math.round(clamped.left * sourceWidth);
	const y = Math.round(clamped.top * sourceHeight);
	const width = Math.max(
		1,
		Math.round(sourceWidth * (1 - clamped.left - clamped.right)),
	);
	const height = Math.max(
		1,
		Math.round(sourceHeight * (1 - clamped.top - clamped.bottom)),
	);
	// Guard the rect against float drift pushing it past the source bounds.
	const clampedX = Math.min(x, Math.max(0, sourceWidth - width));
	const clampedY = Math.min(y, Math.max(0, sourceHeight - height));
	return { x: clampedX, y: clampedY, width, height };
}
