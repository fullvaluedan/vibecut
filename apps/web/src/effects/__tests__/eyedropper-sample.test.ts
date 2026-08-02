import { describe, expect, test } from "bun:test";
import {
	MAGNIFIER_PIXEL_SPAN,
	SAMPLE_RADIUS,
	previewPointToSourcePixel,
	readPixel,
	rgbToHex,
	sampleAverageColor,
} from "@/effects/eyedropper/sample";
import type { EyedropperTransform } from "@/effects/eyedropper/sample";

const IDENTITY: EyedropperTransform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

const HD = { width: 1920, height: 1080 };
const SQUARE = { width: 1000, height: 1000 };

function pick({
	x,
	y,
	canvasSize = HD,
	sourceSize = HD,
	crop,
	transform = IDENTITY,
}: {
	x: number;
	y: number;
	canvasSize?: { width: number; height: number };
	sourceSize?: { width: number; height: number };
	crop?: { left: number; top: number; right: number; bottom: number };
	transform?: EyedropperTransform;
}) {
	return previewPointToSourcePixel({
		point: { x, y },
		canvasSize,
		sourceSize,
		crop,
		transform,
	});
}

describe("previewPointToSourcePixel: full-frame clip", () => {
	test("the centre of the preview is the centre of the source", () => {
		expect(pick({ x: 0.5, y: 0.5 })).toEqual({ x: 960, y: 540 });
	});

	test("the corners map to the source's corners", () => {
		expect(pick({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
		// The far edge lands exactly ON the boundary, so it clamps into range
		// rather than reading one pixel past the buffer.
		expect(pick({ x: 1, y: 1 })).toEqual({ x: 1919, y: 1079 });
	});

	test("a quarter across is a quarter into the source", () => {
		expect(pick({ x: 0.25, y: 0.75 })).toEqual({ x: 480, y: 810 });
	});

	test("a point outside the preview rect is refused", () => {
		expect(pick({ x: -0.1, y: 0.5 })).toBeNull();
		expect(pick({ x: 0.5, y: 1.4 })).toBeNull();
	});
});

describe("previewPointToSourcePixel: contain-fit letterboxing", () => {
	// A 1000x1000 source in a 1920x1080 canvas contains to 1080x1080, centred,
	// so 420px of letterbox sits either side.
	const source = SQUARE;

	test("the picture's own centre still maps to the source centre", () => {
		expect(pick({ x: 0.5, y: 0.5, sourceSize: source })).toEqual({
			x: 500,
			y: 500,
		});
	});

	test("the letterbox bars are not part of the clip", () => {
		// 420/1920 = 0.21875 is the picture's left edge; anything left of it is bar.
		expect(pick({ x: 0.1, y: 0.5, sourceSize: source })).toBeNull();
		expect(pick({ x: 0.9, y: 0.5, sourceSize: source })).toBeNull();
	});

	test("the picture's left edge maps to source column 0", () => {
		expect(pick({ x: 420 / 1920, y: 0.5, sourceSize: source })).toEqual({
			x: 0,
			y: 500,
		});
	});
});

describe("previewPointToSourcePixel: crop", () => {
	// Crop 25% off each side: the visible rect is source columns 250..750,
	// and the renderer treats that 500x1000 rect as the natural size.
	const crop = { left: 0.25, top: 0, right: 0.25, bottom: 0 };

	test("the centre of the cropped picture is still the source centre", () => {
		expect(
			pick({ x: 0.5, y: 0.5, canvasSize: SQUARE, sourceSize: SQUARE, crop }),
		).toEqual({ x: 500, y: 500 });
	});

	test("the left edge of the cropped picture is the crop's own left edge", () => {
		// The 500-wide crop contains into 1000x1000 at scale 1, so it paints
		// canvas columns 250..750 -> preview x 0.25 is its left edge.
		expect(
			pick({ x: 0.25, y: 0.5, canvasSize: SQUARE, sourceSize: SQUARE, crop }),
		).toEqual({ x: 250, y: 500 });
	});

	test("cropped-away source pixels are unreachable", () => {
		const leftmost = pick({
			x: 0.26,
			y: 0.5,
			canvasSize: SQUARE,
			sourceSize: SQUARE,
			crop,
		});
		expect(leftmost).not.toBeNull();
		expect(leftmost?.x).toBeGreaterThanOrEqual(250);
	});

	test("a no-op crop behaves exactly like no crop at all", () => {
		const noOp = { left: 0, top: 0, right: 0, bottom: 0 };
		expect(
			pick({ x: 0.3, y: 0.7, canvasSize: SQUARE, sourceSize: SQUARE, crop: noOp }),
		).toEqual(pick({ x: 0.3, y: 0.7, canvasSize: SQUARE, sourceSize: SQUARE }));
	});
});

describe("previewPointToSourcePixel: transform", () => {
	test("a moved clip is sampled where it actually sits", () => {
		const moved: EyedropperTransform = {
			...IDENTITY,
			position: { x: 200, y: -100 },
		};
		expect(
			pick({
				x: (500 + 200) / 1000,
				y: (500 - 100) / 1000,
				canvasSize: SQUARE,
				sourceSize: SQUARE,
				transform: moved,
			}),
		).toEqual({ x: 500, y: 500 });
	});

	test("a scaled-up clip maps a smaller screen step to the same source step", () => {
		const scaled: EyedropperTransform = { ...IDENTITY, scaleX: 2, scaleY: 2 };
		// At 2x the quad is 2000px wide over a 1000px canvas, so the visible
		// half of the source runs from column 250 to 750.
		expect(
			pick({
				x: 0,
				y: 0.5,
				canvasSize: SQUARE,
				sourceSize: SQUARE,
				transform: scaled,
			}),
		).toEqual({ x: 250, y: 500 });
	});

	test("a horizontally flipped clip samples the mirrored column", () => {
		const flipped: EyedropperTransform = { ...IDENTITY, scaleX: -1 };
		expect(
			pick({
				x: 0.125,
				y: 0.5,
				canvasSize: SQUARE,
				sourceSize: SQUARE,
				transform: flipped,
			}),
		).toEqual({ x: 875, y: 500 });
		expect(
			pick({
				x: 0.125,
				y: 0.5,
				canvasSize: SQUARE,
				sourceSize: SQUARE,
			}),
		).toEqual({ x: 125, y: 500 });
	});

	test("a rotated clip is un-rotated before sampling", () => {
		const rotated: EyedropperTransform = { ...IDENTITY, rotate: 90 };
		// At +90 degrees the source's left-middle swings to the top-middle of
		// the canvas. Compared with a tolerance because cos(90 degrees) is not
		// exactly 0 in floating point, which can shift a boundary pixel by one.
		const pixel = pick({
			x: 0.5,
			y: 0.125,
			canvasSize: SQUARE,
			sourceSize: SQUARE,
			transform: rotated,
		});
		expect(pixel).not.toBeNull();
		expect(pixel?.x).toBeCloseTo(125, -0.5);
		expect(pixel?.y).toBeCloseTo(500, -0.5);
	});

	test("rotation leaves the centre alone", () => {
		for (const rotate of [0, 30, 90, 180, 270]) {
			expect(
				pick({
					x: 0.5,
					y: 0.5,
					canvasSize: SQUARE,
					sourceSize: SQUARE,
					transform: { ...IDENTITY, rotate },
				}),
			).toEqual({ x: 500, y: 500 });
		}
	});

	test("a rotated clip refuses points that fall outside its turned quad", () => {
		// A 1000x1000 quad turned 45 degrees leaves the canvas corners empty.
		expect(
			pick({
				x: 0.02,
				y: 0.02,
				canvasSize: SQUARE,
				sourceSize: SQUARE,
				transform: { ...IDENTITY, rotate: 45 },
			}),
		).toBeNull();
	});

	test("crop and transform compose in the renderer's order", () => {
		// Crop the top half away, then scale the remainder 2x. The crop rect is
		// 1000x500, contains at scale 1 (1000/1000 vs 1000/500 -> 1), then 2x
		// makes the quad 2000x1000 centred on the canvas: the full crop height
		// is visible, the width is halved.
		const crop = { left: 0, top: 0.5, right: 0, bottom: 0 };
		const scaled: EyedropperTransform = { ...IDENTITY, scaleX: 2, scaleY: 2 };
		expect(
			pick({
				x: 0.5,
				y: 0.5,
				canvasSize: SQUARE,
				sourceSize: SQUARE,
				crop,
				transform: scaled,
			}),
		).toEqual({ x: 500, y: 750 });
	});
});

describe("previewPointToSourcePixel: degenerate inputs", () => {
	test("a zero-sized source is refused", () => {
		expect(pick({ x: 0.5, y: 0.5, sourceSize: { width: 0, height: 0 } })).toBeNull();
	});

	test("a fully collapsed scale is refused instead of dividing by zero", () => {
		expect(
			pick({
				x: 0.5,
				y: 0.5,
				transform: { ...IDENTITY, scaleX: 0 },
			}),
		).toBeNull();
	});
});

describe("pixel reads", () => {
	// 3x3 RGBA: a green centre column, red left, blue right.
	const WIDTH = 3;
	const HEIGHT = 3;
	function buildFrame(): Uint8ClampedArray {
		const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
		const columns = [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
		];
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const offset = (y * WIDTH + x) * 4;
				data[offset] = columns[x][0];
				data[offset + 1] = columns[x][1];
				data[offset + 2] = columns[x][2];
				data[offset + 3] = 255;
			}
		}
		return data;
	}

	test("readPixel returns the addressed texel", () => {
		expect(
			readPixel({ data: buildFrame(), width: WIDTH, height: HEIGHT, x: 1, y: 1 }),
		).toEqual({ r: 0, g: 255, b: 0, a: 255 });
	});

	test("readPixel refuses an out-of-bounds address", () => {
		const data = buildFrame();
		expect(readPixel({ data, width: WIDTH, height: HEIGHT, x: -1, y: 0 })).toBeNull();
		expect(readPixel({ data, width: WIDTH, height: HEIGHT, x: 3, y: 0 })).toBeNull();
		expect(readPixel({ data, width: WIDTH, height: HEIGHT, x: 0, y: 3 })).toBeNull();
	});

	test("radius 0 is the single pixel under the cursor", () => {
		expect(
			sampleAverageColor({
				data: buildFrame(),
				width: WIDTH,
				height: HEIGHT,
				x: 1,
				y: 1,
				radius: 0,
			}),
		).toEqual({ r: 0, g: 255, b: 0 });
	});

	test("a 3x3 average mixes the neighbouring columns", () => {
		expect(
			sampleAverageColor({
				data: buildFrame(),
				width: WIDTH,
				height: HEIGHT,
				x: 1,
				y: 1,
				radius: 1,
			}),
		).toEqual({ r: 85, g: 85, b: 85 });
	});

	test("the average clips to the frame at an edge instead of wrapping", () => {
		// Top-left corner: only the 2x2 block inside the frame counts, which is
		// half red and half green.
		expect(
			sampleAverageColor({
				data: buildFrame(),
				width: WIDTH,
				height: HEIGHT,
				x: 0,
				y: 0,
				radius: 1,
			}),
		).toEqual({ r: 127.5, g: 127.5, b: 0 });
	});

	test("a fully out-of-frame sample yields nothing", () => {
		expect(
			sampleAverageColor({
				data: buildFrame(),
				width: WIDTH,
				height: HEIGHT,
				x: 50,
				y: 50,
				radius: 1,
			}),
		).toBeNull();
	});
});

describe("rgbToHex", () => {
	test("formats an exact colour", () => {
		expect(rgbToHex({ r: 0, g: 255, b: 0 })).toBe("#00FF00");
		expect(rgbToHex({ r: 51, g: 102, b: 153 })).toBe("#336699");
	});

	test("rounds a fractional average and clamps out-of-range channels", () => {
		expect(rgbToHex({ r: 127.5, g: 0.4, b: 254.6 })).toBe("#8000FF");
		expect(rgbToHex({ r: -20, g: 300, b: 0 })).toBe("#00FF00");
	});
});

describe("magnifier constants", () => {
	test("the zoom window is an odd span so it has a true centre pixel", () => {
		expect(MAGNIFIER_PIXEL_SPAN % 2).toBe(1);
		expect(MAGNIFIER_PIXEL_SPAN).toBe(11);
	});

	test("a pick averages a 3x3 block", () => {
		expect(SAMPLE_RADIUS).toBe(1);
	});
});
