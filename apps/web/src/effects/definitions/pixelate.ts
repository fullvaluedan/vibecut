import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const PIXELATE_SHADER = "pixelate";

/** Below this UI value a block is 1 output pixel, i.e. no visible change. */
const NEUTRAL_BLOCK_SIZE = 1;

/**
 * UI block size (1..100) is scaled by the render target's width against a
 * 1920px reference, the same "reference resolution" convention blur.ts's
 * `intensityToSigma` uses: the same UI value always reads as the same
 * FRACTION of the frame, whether previewing at 160x160 or exporting at
 * 3840x2160, instead of a fixed pixel count that would look chunkier at
 * lower render resolutions.
 */
const REFERENCE_WIDTH = 1920;

export function blockSizeToPixels({
	blockSize,
	width,
}: {
	blockSize: number;
	width: number;
}): number {
	return Math.max(1, blockSize * (width / REFERENCE_WIDTH));
}

function parseBlockSize(effectParams: ParamValues): number {
	const raw = effectParams.blockSize;
	return typeof raw === "number" ? raw : Number.parseFloat(String(raw));
}

export function isPixelateNeutral({
	effectParams,
}: {
	effectParams: ParamValues;
}): boolean {
	return parseBlockSize(effectParams) <= NEUTRAL_BLOCK_SIZE;
}

export function buildPixelatePasses({
	effectParams,
	width,
}: {
	effectParams: ParamValues;
	width: number;
}): EffectPass[] {
	if (isPixelateNeutral({ effectParams })) return [];

	return [
		{
			shader: PIXELATE_SHADER,
			uniforms: {
				u_block_size: blockSizeToPixels({
					blockSize: parseBlockSize(effectParams),
					width,
				}),
			},
		},
	];
}

export const pixelateEffectDefinition: EffectDefinition = {
	type: "pixelate",
	name: "Pixelate",
	keywords: ["pixelate", "mosaic", "censor", "block"],
	params: [
		{
			key: "blockSize",
			label: "Block Size",
			type: "number",
			default: 1,
			min: 1,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		// No static `passes`: buildPasses is the only path (mirrors blur.ts and
		// color-adjust.ts), since the neutral early-out needs to skip the GPU
		// pass entirely rather than emit a no-op 1px-block pass.
		passes: [],
		buildPasses: ({ effectParams, width }) =>
			buildPixelatePasses({ effectParams, width }),
	},
};
