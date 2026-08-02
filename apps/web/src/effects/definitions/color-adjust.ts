import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const COLOR_ADJUST_SHADER = "color-adjust";

/**
 * The 9 param keys the Adjust effect exposes, in the same order the shader
 * packs its scalar slots (see rust/crates/effects/src/shaders/color_adjust.wgsl
 * and its pipeline.rs registration).
 */
export const COLOR_ADJUST_PARAM_KEYS = [
	"brightness",
	"contrast",
	"saturation",
	"exposure",
	"temperature",
	"tint",
	"highlights",
	"shadows",
	"sharpen",
] as const;

export type ColorAdjustParamKey = (typeof COLOR_ADJUST_PARAM_KEYS)[number];

export type ColorAdjustParamValues = Record<ColorAdjustParamKey, number>;

function readNumberParam({
	effectParams,
	key,
}: {
	effectParams: ParamValues;
	key: ColorAdjustParamKey;
}): number {
	const raw = effectParams[key];
	return typeof raw === "number" ? raw : Number.parseFloat(String(raw));
}

function readAllParams({
	effectParams,
}: {
	effectParams: ParamValues;
}): ColorAdjustParamValues {
	const values = {} as ColorAdjustParamValues;
	for (const key of COLOR_ADJUST_PARAM_KEYS) {
		values[key] = readNumberParam({ effectParams, key });
	}
	return values;
}

/**
 * True when every UI param sits at its neutral default (all 9 defaults are
 * 0), i.e. the Adjust effect would leave the frame untouched. Mirrors blur's
 * `maxSigma < 0.001` early-out (blur.ts): buildPasses returns [] so the T19.0
 * pipeline hygiene pass skips the blit entirely.
 */
export function isColorAdjustNeutral({
	effectParams,
}: {
	effectParams: ParamValues;
}): boolean {
	return COLOR_ADJUST_PARAM_KEYS.every(
		(key) => readNumberParam({ effectParams, key }) === 0,
	);
}

/**
 * Maps the UI-space param values (documented ranges on each ParamDefinition
 * below) to the shader-space values the WGSL pass consumes. Each mapping is
 * intentionally simple and documented; see color_adjust.wgsl for how the
 * shader-space value is used.
 */
export function buildColorAdjustUniforms({
	effectParams,
}: {
	effectParams: ParamValues;
}): Record<string, number> {
	const values = readAllParams({ effectParams });

	return {
		// Exposure is already in stops (-3..3); the shader multiplies by 2^stops.
		u_exposure: values.exposure,
		// -100..100 UI -> -1..1 shader scale factor.
		u_temperature: values.temperature / 100,
		u_tint: values.tint / 100,
		// -100..100 UI -> -1..1 shader contrast amount (multiplier is 1 + amount).
		u_contrast: values.contrast / 100,
		// -100..100 UI -> -1..1 shader gain/lift amount.
		u_highlights: values.highlights / 100,
		u_shadows: values.shadows / 100,
		// -100..100 UI -> 0..2 shader multiplier (0 = grayscale, 1 = unchanged).
		u_saturation: 1 + values.saturation / 100,
		// -100..100 UI -> -0.5..0.5 additive shader offset.
		u_brightness: values.brightness / 200,
		// 0..100 UI -> 0..2 shader unsharp amount.
		u_sharpen: (values.sharpen / 100) * 2,
	};
}

export function buildColorAdjustPasses({
	effectParams,
}: {
	effectParams: ParamValues;
}): EffectPass[] {
	if (isColorAdjustNeutral({ effectParams })) return [];

	return [
		{
			shader: COLOR_ADJUST_SHADER,
			uniforms: buildColorAdjustUniforms({ effectParams }),
		},
	];
}

export const colorAdjustEffectDefinition: EffectDefinition = {
	type: "color-adjust",
	name: "Adjust",
	keywords: ["color", "adjust", "grade", "filter", "correction"],
	params: [
		{
			key: "brightness",
			label: "Brightness",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "contrast",
			label: "Contrast",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "saturation",
			label: "Saturation",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "exposure",
			label: "Exposure",
			type: "number",
			default: 0,
			min: -3,
			max: 3,
			step: 0.05,
		},
		{
			key: "temperature",
			label: "Temperature",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "tint",
			label: "Tint",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "highlights",
			label: "Highlights",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "shadows",
			label: "Shadows",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "sharpen",
			label: "Sharpen",
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		// No static `passes`: buildPasses is the only path (mirrors blur.ts's
		// use of buildPasses for the neutral early-out), since one pass either
		// exists or it does not - there is no fixed per-pass uniform template
		// to express statically.
		passes: [],
		buildPasses: ({ effectParams }) => buildColorAdjustPasses({ effectParams }),
	},
};
