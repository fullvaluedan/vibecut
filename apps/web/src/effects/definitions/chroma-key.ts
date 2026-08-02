import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";
import { parseColorToLinearRgba } from "@/params";

export const CHROMA_KEY_SHADER = "chroma-key";
export const CHROMA_KEY_EFFECT_TYPE = "chroma-key";
export const DEFAULT_CHROMA_KEY_COLOR = "#00FF00";

/**
 * Sliders are 0..100 for the user; the shader wants 0..1. One divisor for all
 * four, so "similarity 20" is a chroma distance of 0.20 and nothing else has
 * to be remembered. For scale: a neutral grey pixel sits 0.534 away from pure
 * green in the chroma plane, so the default similarity of 20 leaves grey
 * comfortably opaque.
 */
export const CHROMA_KEY_PARAM_SCALE = 100;

/**
 * Mirrors chroma_key.wgsl's own epsilon. smoothstep needs a non-empty edge
 * range and two divisors below need a non-zero denominator.
 */
const EPSILON = 0.0001;

/** Mirrors chroma_key.wgsl. See the shader for why this margin exists. */
const SHADOW_LUMA_MARGIN = 0.15;

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/* ------------------------------------------------------------------------ *
 * REFERENCE IMPLEMENTATION of rust/crates/effects/src/shaders/chroma_key.wgsl
 *
 * The shader is the thing that actually renders; these functions exist so the
 * keying math can be tested on synthetic pixels without a GPU. They are a
 * line-for-line mirror of the WGSL, in the same order, with the same
 * constants. CHANGING ONE MEANS CHANGING THE OTHER.
 *
 * Colour space: the compositor's textures are `Bgra8Unorm`/`Rgba8Unorm` (see
 * rust/crates/gpu/src/context.rs), NOT an `*Srgb` format, so `textureSample`
 * hands the shader the sRGB-ENCODED channel values, not linear light. Every
 * function here therefore takes the same sRGB-encoded 0..1 channels.
 * ------------------------------------------------------------------------ */

/** BT.601 luma. */
export function chromaKeyLuma({ color }: { color: Rgb }): number {
	return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

/** BT.601 Cb/Cr. */
export function chromaKeyChroma({ color }: { color: Rgb }): {
	cb: number;
	cr: number;
} {
	return {
		cb: -0.168736 * color.r - 0.331264 * color.g + 0.5 * color.b,
		cr: 0.5 * color.r - 0.418688 * color.g - 0.081312 * color.b,
	};
}

function smoothstep({
	edge0,
	edge1,
	value,
}: {
	edge0: number;
	edge1: number;
	value: number;
}): number {
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

export interface ChromaKeySettings {
	/** Chroma-plane distance at which a pixel is still fully cut out (0..1). */
	similarity: number;
	/** Width of the soft edge above `similarity` (0..1). */
	smoothness: number;
	/** How much of the key hue to desaturate out of kept pixels (0..1). */
	spill: number;
	/** How much alpha a shadow on the key surface keeps (0..1). */
	shadow: number;
}

/**
 * Step 1 + 2 of the shader: the keyed alpha for one pixel, BEFORE it is
 * multiplied by the pixel's own source alpha.
 */
export function chromaKeyAlpha({
	pixel,
	keyColor,
	settings,
}: {
	pixel: Rgb;
	keyColor: Rgb;
	settings: ChromaKeySettings;
}): number {
	const smoothness = Math.max(settings.smoothness, EPSILON);
	const keyChroma = chromaKeyChroma({ color: keyColor });
	const pixelChroma = chromaKeyChroma({ color: pixel });

	const chromaDistance = Math.hypot(
		pixelChroma.cb - keyChroma.cb,
		pixelChroma.cr - keyChroma.cr,
	);
	const keyed = smoothstep({
		edge0: settings.similarity,
		edge1: settings.similarity + smoothness,
		value: chromaDistance,
	});

	const keyLuma = chromaKeyLuma({ color: keyColor });
	const pixelLuma = chromaKeyLuma({ color: pixel });
	const shadowRange = Math.max(keyLuma - SHADOW_LUMA_MARGIN, EPSILON);
	const shadowDrop = Math.min(
		1,
		Math.max(0, (shadowRange - pixelLuma) / shadowRange),
	);

	return Math.min(1, Math.max(0, Math.max(keyed, settings.shadow * shadowDrop)));
}

/** Step 3 of the shader: spill suppression on the kept colour. */
export function chromaKeyDespill({
	pixel,
	keyColor,
	spill,
}: {
	pixel: Rgb;
	keyColor: Rgb;
	spill: number;
}): Rgb {
	const keyChroma = chromaKeyChroma({ color: keyColor });
	const pixelChroma = chromaKeyChroma({ color: pixel });
	const keyChromaEnergy = Math.max(
		keyChroma.cb * keyChroma.cb + keyChroma.cr * keyChroma.cr,
		EPSILON,
	);
	const spillAmount = Math.min(
		1,
		Math.max(
			0,
			(pixelChroma.cb * keyChroma.cb + pixelChroma.cr * keyChroma.cr) /
				keyChromaEnergy,
		),
	);
	const pixelLuma = chromaKeyLuma({ color: pixel });
	const mixAmount = spillAmount * spill;

	return {
		r: pixel.r + (pixelLuma - pixel.r) * mixAmount,
		g: pixel.g + (pixelLuma - pixel.g) * mixAmount,
		b: pixel.b + (pixelLuma - pixel.b) * mixAmount,
	};
}

/**
 * The whole shader for one pixel. Alpha out is STRAIGHT (non-premultiplied),
 * matching the compositor: `premultiplied_alpha: false` on upload
 * (rust/crates/gpu/src/context.rs) and blend.wgsl multiplying the layer's rgb
 * by its own alpha at blend time.
 */
export function applyChromaKeyToPixel({
	pixel,
	sourceAlpha = 1,
	keyColor,
	settings,
}: {
	pixel: Rgb;
	sourceAlpha?: number;
	keyColor: Rgb;
	settings: ChromaKeySettings;
}): { color: Rgb; alpha: number } {
	return {
		color: chromaKeyDespill({ pixel, keyColor, spill: settings.spill }),
		alpha: chromaKeyAlpha({ pixel, keyColor, settings }) * sourceAlpha,
	};
}

/* ------------------------------ param plumbing --------------------------- */

function parseNumber({
	effectParams,
	key,
	fallback,
}: {
	effectParams: ParamValues;
	key: string;
	fallback: number;
}): number {
	const raw = effectParams[key];
	const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	return Number.isFinite(value) ? value : fallback;
}

/**
 * sRGB transfer curve, the inverse of `srgbToLinear` in `@/params`. The colour
 * param stores a hex string and the shared channel layout decomposes it into
 * LINEAR components for keyframe interpolation, but the shader compares
 * against sRGB-encoded texels (see the colour-space note above), so the round
 * trip back out of linear happens here and nowhere else.
 */
function linearChannelToDisplay({ value }: { value: number }): number {
	const clamped = Math.min(1, Math.max(0, value));
	return clamped <= 0.0031308
		? clamped * 12.92
		: 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * Colour param (hex string, `LinearRgba` channel layout) -> the shader's vec4
 * slot. The fourth component is the parsed alpha; the shader ignores it, and
 * it is carried rather than hard-coded to 1 so the packed vector always
 * describes the colour the user actually chose.
 */
export function keyColorToUniform({
	color,
}: {
	color: string;
}): [number, number, number, number] {
	const linear =
		parseColorToLinearRgba({ color }) ??
		parseColorToLinearRgba({ color: DEFAULT_CHROMA_KEY_COLOR });
	if (!linear) {
		return [0, 1, 0, 1];
	}
	return [
		linearChannelToDisplay({ value: linear.r }),
		linearChannelToDisplay({ value: linear.g }),
		linearChannelToDisplay({ value: linear.b }),
		linear.a,
	];
}

export function readChromaKeySettings({
	effectParams,
}: {
	effectParams: ParamValues;
}): ChromaKeySettings {
	return {
		similarity:
			parseNumber({ effectParams, key: "similarity", fallback: 20 }) /
			CHROMA_KEY_PARAM_SCALE,
		smoothness:
			parseNumber({ effectParams, key: "smoothness", fallback: 10 }) /
			CHROMA_KEY_PARAM_SCALE,
		spill:
			parseNumber({ effectParams, key: "spill", fallback: 50 }) /
			CHROMA_KEY_PARAM_SCALE,
		shadow:
			parseNumber({ effectParams, key: "shadow", fallback: 0 }) /
			CHROMA_KEY_PARAM_SCALE,
	};
}

export function buildChromaKeyPasses({
	effectParams,
}: {
	effectParams: ParamValues;
}): EffectPass[] {
	const settings = readChromaKeySettings({ effectParams });
	const keyColor =
		typeof effectParams.keyColor === "string"
			? effectParams.keyColor
			: DEFAULT_CHROMA_KEY_COLOR;

	// No neutral early-out on purpose. Unlike blur, "all sliders at zero" is
	// still a meaningful key (it cuts exactly the key colour and nothing else),
	// so dropping the pass would make the effect silently stop working at the
	// bottom of its own range.
	return [
		{
			shader: CHROMA_KEY_SHADER,
			uniforms: {
				u_similarity: settings.similarity,
				u_smoothness: settings.smoothness,
				u_spill: settings.spill,
				u_shadow: settings.shadow,
				u_key_color: keyColorToUniform({ color: keyColor }),
			},
		},
	];
}

export const chromaKeyEffectDefinition: EffectDefinition = {
	type: CHROMA_KEY_EFFECT_TYPE,
	name: "Chroma key",
	keywords: ["chroma", "key", "green screen", "greenscreen", "cutout", "alpha"],
	params: [
		{
			key: "keyColor",
			label: "Key color",
			type: "color",
			default: DEFAULT_CHROMA_KEY_COLOR,
		},
		{
			key: "similarity",
			label: "Similarity",
			type: "number",
			default: 20,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "smoothness",
			label: "Smoothness",
			type: "number",
			default: 10,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "spill",
			label: "Spill",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "shadow",
			label: "Shadow",
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: CHROMA_KEY_SHADER,
				uniforms: ({ effectParams }) => {
					const pass = buildChromaKeyPasses({ effectParams })[0];
					return pass.uniforms;
				},
			},
		],
		buildPasses: ({ effectParams }) => buildChromaKeyPasses({ effectParams }),
	},
};
