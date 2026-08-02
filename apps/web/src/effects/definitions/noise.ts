import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const NOISE_SHADER = "noise";

export const NOISE_PARAM_KEYS = ["amount", "size"] as const;

export type NoiseParamKey = (typeof NOISE_PARAM_KEYS)[number];

function readNumberParam({
	effectParams,
	key,
}: {
	effectParams: ParamValues;
	key: NoiseParamKey;
}): number {
	const raw = effectParams[key];
	return typeof raw === "number" ? raw : Number.parseFloat(String(raw));
}

/** `amount` at 0 leaves the frame untouched regardless of `size`/time. */
export function isNoiseNeutral({
	effectParams,
}: {
	effectParams: ParamValues;
}): boolean {
	return readNumberParam({ effectParams, key: "amount" }) === 0;
}

export function buildNoiseUniforms({
	effectParams,
	time,
}: {
	effectParams: ParamValues;
	time: number;
}): Record<string, number> {
	const amount = readNumberParam({ effectParams, key: "amount" });
	const size = readNumberParam({ effectParams, key: "size" });

	return {
		// 0..100 UI -> 0..0.5 shader-space blend of the +-1 grain value.
		u_amount: (amount / 100) * 0.5,
		// 0..100 UI -> 1..6px grain cell size.
		u_grain_size: 1 + (size / 100) * 5,
		u_time: time,
	};
}

/**
 * NOISE'S TIME UNIFORM (T19.4b finding): resolve.ts already computed a
 * clip-local `localTime`/`time` value at every call site that reaches
 * resolveEffectPasses (resolveEffectPassGroups for clip/text effects,
 * resolveEffectLayerNode for standalone Effect elements) - it just was not
 * threaded into EffectPassTemplate/EffectRendererConfig's signatures yet.
 * Adding an optional `time` field to both (types.ts) and a `time = 0`
 * default parameter to resolveEffectPasses (effects/index.ts) was the whole
 * change; this effect is the reason it exists. Preview tiles (which have no
 * timeline clock) fall back to time=0, i.e. a single static grain frame,
 * which is a reasonable still-image rendering of an animated effect.
 */
export function buildNoisePasses({
	effectParams,
	time = 0,
}: {
	effectParams: ParamValues;
	time?: number;
}): EffectPass[] {
	if (isNoiseNeutral({ effectParams })) return [];

	return [
		{
			shader: NOISE_SHADER,
			uniforms: buildNoiseUniforms({ effectParams, time }),
		},
	];
}

export const noiseEffectDefinition: EffectDefinition = {
	type: "noise",
	name: "Noise",
	keywords: ["noise", "grain", "film grain", "static"],
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
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams, time }) =>
			buildNoisePasses({ effectParams, time }),
	},
};
