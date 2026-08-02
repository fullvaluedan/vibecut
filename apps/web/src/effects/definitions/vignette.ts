import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const VIGNETTE_SHADER = "vignette";

export const VIGNETTE_PARAM_KEYS = [
	"amount",
	"size",
	"feather",
	"roundness",
] as const;

export type VignetteParamKey = (typeof VIGNETTE_PARAM_KEYS)[number];

function readNumberParam({
	effectParams,
	key,
}: {
	effectParams: ParamValues;
	key: VignetteParamKey;
}): number {
	const raw = effectParams[key];
	return typeof raw === "number" ? raw : Number.parseFloat(String(raw));
}

/** `amount` at 0 leaves the frame untouched regardless of the other 3 params. */
export function isVignetteNeutral({
	effectParams,
}: {
	effectParams: ParamValues;
}): boolean {
	return readNumberParam({ effectParams, key: "amount" }) === 0;
}

/**
 * Maps the 4 UI-space params (0..100 each) to the shader-space values
 * vignette.wgsl consumes. See that file's fragment_main comment for how each
 * value is used.
 */
export function buildVignetteUniforms({
	effectParams,
}: {
	effectParams: ParamValues;
}): Record<string, number> {
	const amount = readNumberParam({ effectParams, key: "amount" });
	const size = readNumberParam({ effectParams, key: "size" });
	const feather = readNumberParam({ effectParams, key: "feather" });
	const roundness = readNumberParam({ effectParams, key: "roundness" });

	return {
		// 0..100 UI -> 0..1 blend strength (0 = identity, matched by the
		// neutral early-out above so this value never actually reaches 0 on
		// the GPU path).
		u_amount: amount / 100,
		// 0..100 UI -> 0..0.9 shader-space radius. 0.9 sits just past the
		// midpoints of the frame edges, so at size=100 the vignette is only
		// visible tucked into the corners; at size=0 the whole frame reads
		// as outside the bright center.
		u_radius: (size / 100) * 0.9,
		// 0..100 UI -> 0..0.5 shader-space softness (half the frame's short
		// axis at most, i.e. always short of a hard edge).
		u_feather: (feather / 100) * 0.5,
		// 0..100 UI -> 0..1 shader-space blend between a rectangular and an
		// elliptical falloff (see vignette.wgsl).
		u_roundness: roundness / 100,
	};
}

export function buildVignettePasses({
	effectParams,
}: {
	effectParams: ParamValues;
}): EffectPass[] {
	if (isVignetteNeutral({ effectParams })) return [];

	return [
		{
			shader: VIGNETTE_SHADER,
			uniforms: buildVignetteUniforms({ effectParams }),
		},
	];
}

export const vignetteEffectDefinition: EffectDefinition = {
	type: "vignette",
	name: "Vignette",
	keywords: ["vignette", "darken edges", "frame", "focus"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "size",
			label: "Size",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "feather",
			label: "Feather",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "roundness",
			label: "Roundness",
			type: "number",
			default: 100,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => buildVignettePasses({ effectParams }),
	},
};
