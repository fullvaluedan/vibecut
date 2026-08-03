import { intensityToSigma } from "@/effects/definitions/blur";
import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const GLOW_SHADER = "glow";

export const GLOW_PARAM_KEYS = ["threshold", "intensity", "radius"] as const;

export type GlowParamKey = (typeof GLOW_PARAM_KEYS)[number];

function readNumberParam({
	effectParams,
	key,
}: {
	effectParams: ParamValues;
	key: GlowParamKey;
}): number {
	const raw = effectParams[key];
	return typeof raw === "number" ? raw : Number.parseFloat(String(raw));
}

/**
 * `intensity` at 0 makes the additive bloom term always 0 regardless of
 * threshold/radius, so nothing distinguishes the pass from an identity blit -
 * skip it entirely, same convention as blur's `maxSigma < 0.001` early-out.
 */
export function isGlowNeutral({
	effectParams,
}: {
	effectParams: ParamValues;
}): boolean {
	return readNumberParam({ effectParams, key: "intensity" }) <= 0;
}

function buildGlowUniforms({
	effectParams,
	radiusPx,
	direction,
}: {
	effectParams: ParamValues;
	radiusPx: number;
	direction: [number, number];
}): Record<string, number | number[]> {
	const threshold = readNumberParam({ effectParams, key: "threshold" });
	const intensity = readNumberParam({ effectParams, key: "intensity" });

	return {
		// 0..100 UI -> 0..1 shader-space luma cutoff.
		u_threshold: threshold / 100,
		// 0..100 UI -> 0..1.5 shader-space additive strength.
		u_intensity: (intensity / 100) * 1.5,
		u_radius: Math.max(radiusPx, 0.5),
		u_direction: direction,
	};
}

/**
 * Two passes: horizontal then vertical, exactly like blur's H/V split (see
 * glow.wgsl's top comment for why this is the "combine" step too - each pass
 * adds its bloom contribution directly to its own input, so there is no
 * separate extract or combine pass and no second texture read).
 */
export function buildGlowPasses({
	effectParams,
	width,
	height,
}: {
	effectParams: ParamValues;
	width: number;
	height: number;
}): EffectPass[] {
	if (isGlowNeutral({ effectParams })) return [];

	const radius = readNumberParam({ effectParams, key: "radius" });
	const radiusX = intensityToSigma({ intensity: radius, resolution: width, reference: 1920 });
	const radiusY = intensityToSigma({ intensity: radius, resolution: height, reference: 1080 });

	return [
		{
			shader: GLOW_SHADER,
			uniforms: buildGlowUniforms({
				effectParams,
				radiusPx: radiusX,
				direction: [1, 0],
			}),
		},
		{
			shader: GLOW_SHADER,
			uniforms: buildGlowUniforms({
				effectParams,
				radiusPx: radiusY,
				direction: [0, 1],
			}),
		},
	];
}

export const glowEffectDefinition: EffectDefinition = {
	type: "glow",
	name: "Glow",
	keywords: ["glow", "bloom", "shine", "halo"],
	// intensity is the neutral param; a lowered threshold lets the preview
	// image's bright background bloom so the effect is unmistakable.
	previewParams: { intensity: 80, threshold: 55 },
	params: [
		{
			key: "threshold",
			label: "Threshold",
			type: "number",
			default: 70,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "radius",
			label: "Radius",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams, width, height }) =>
			buildGlowPasses({ effectParams, width, height }),
	},
};
