import { describe, expect, test } from "bun:test";
import {
	NOISE_SHADER,
	buildNoisePasses,
	buildNoiseUniforms,
	isNoiseNeutral,
	noiseEffectDefinition,
} from "@/effects/definitions/noise";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";

function defaultParams(): ParamValues {
	return buildDefaultParamValues(noiseEffectDefinition.params);
}

describe("noise definition", () => {
	test("has exactly the 2 documented params", () => {
		expect(noiseEffectDefinition.params.map((p) => p.key).sort()).toEqual(
			["amount", "size"].sort(),
		);
	});

	test("amount defaults to 0 (identity)", () => {
		const byKey = Object.fromEntries(
			noiseEffectDefinition.params.map((p) => [p.key, p]),
		);
		expect(byKey.amount).toMatchObject({ min: 0, max: 100, default: 0 });
	});

	test("all params are keyframable by default", () => {
		for (const param of noiseEffectDefinition.params) {
			expect(param.keyframable).not.toBe(false);
		}
	});
});

describe("isNoiseNeutral", () => {
	test("the default (amount=0) is neutral", () => {
		expect(isNoiseNeutral({ effectParams: defaultParams() })).toBe(true);
	});

	test("any positive amount is not neutral", () => {
		expect(
			isNoiseNeutral({ effectParams: { ...defaultParams(), amount: 1 } }),
		).toBe(false);
	});
});

describe("buildNoisePasses", () => {
	test("neutral params resolve to zero passes", () => {
		expect(
			buildNoisePasses({ effectParams: defaultParams() }),
		).toHaveLength(0);
	});

	test("a non-neutral amount resolves to exactly one pass on the noise shader", () => {
		const passes = buildNoisePasses({
			effectParams: { ...defaultParams(), amount: 40 },
			time: 2,
		});
		expect(passes).toHaveLength(1);
		expect(passes[0].shader).toBe(NOISE_SHADER);
		expect(Object.keys(passes[0].uniforms).sort()).toEqual(
			["u_amount", "u_grain_size", "u_time"].sort(),
		);
	});

	test("time defaults to 0 when omitted (e.g. a still preview tile)", () => {
		const passes = buildNoisePasses({
			effectParams: { ...defaultParams(), amount: 40 },
		});
		expect(passes[0].uniforms.u_time).toBe(0);
	});

	test("a non-zero time flows through into u_time (animates the grain seed)", () => {
		const passes = buildNoisePasses({
			effectParams: { ...defaultParams(), amount: 40 },
			time: 3.5,
		});
		expect(passes[0].uniforms.u_time).toBe(3.5);
	});
});

describe("buildNoiseUniforms UI -> shader mapping", () => {
	test("amount maps 0..100 to a 0..0.5 grain blend", () => {
		expect(
			buildNoiseUniforms({ effectParams: { ...defaultParams(), amount: 100 }, time: 0 })
				.u_amount,
		).toBeCloseTo(0.5);
	});

	test("size maps 0..100 to a 1..6px grain cell", () => {
		expect(
			buildNoiseUniforms({ effectParams: { ...defaultParams(), size: 0 }, time: 0 })
				.u_grain_size,
		).toBeCloseTo(1);
		expect(
			buildNoiseUniforms({ effectParams: { ...defaultParams(), size: 100 }, time: 0 })
				.u_grain_size,
		).toBeCloseTo(6);
	});
});
