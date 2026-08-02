import { describe, expect, test } from "bun:test";
import {
	VIGNETTE_SHADER,
	buildVignettePasses,
	buildVignetteUniforms,
	isVignetteNeutral,
	vignetteEffectDefinition,
} from "@/effects/definitions/vignette";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";

function defaultParams(): ParamValues {
	return buildDefaultParamValues(vignetteEffectDefinition.params);
}

describe("vignette definition", () => {
	test("has exactly the 4 documented params", () => {
		expect(vignetteEffectDefinition.params.map((p) => p.key).sort()).toEqual(
			["amount", "feather", "roundness", "size"].sort(),
		);
	});

	test("amount defaults to 0 (identity)", () => {
		const byKey = Object.fromEntries(
			vignetteEffectDefinition.params.map((p) => [p.key, p]),
		);
		expect(byKey.amount).toMatchObject({ min: 0, max: 100, default: 0 });
	});

	test("all params are keyframable by default", () => {
		for (const param of vignetteEffectDefinition.params) {
			expect(param.keyframable).not.toBe(false);
		}
	});
});

describe("isVignetteNeutral", () => {
	test("the default (amount=0) is neutral", () => {
		expect(isVignetteNeutral({ effectParams: defaultParams() })).toBe(true);
	});

	test("amount=0 is neutral even if size/feather/roundness are non-default", () => {
		expect(
			isVignetteNeutral({
				effectParams: { amount: 0, size: 10, feather: 90, roundness: 0 },
			}),
		).toBe(true);
	});

	test("any positive amount is not neutral", () => {
		expect(
			isVignetteNeutral({ effectParams: { ...defaultParams(), amount: 1 } }),
		).toBe(false);
	});
});

describe("buildVignettePasses", () => {
	test("neutral params resolve to zero passes", () => {
		expect(
			buildVignettePasses({ effectParams: defaultParams() }),
		).toHaveLength(0);
	});

	test("a non-neutral amount resolves to exactly one pass on the vignette shader", () => {
		const passes = buildVignettePasses({
			effectParams: { ...defaultParams(), amount: 60 },
		});
		expect(passes).toHaveLength(1);
		expect(passes[0].shader).toBe(VIGNETTE_SHADER);
		expect(Object.keys(passes[0].uniforms).sort()).toEqual(
			["u_amount", "u_feather", "u_radius", "u_roundness"].sort(),
		);
	});
});

describe("buildVignetteUniforms UI -> shader mapping", () => {
	test("amount divides by 100 into 0..1", () => {
		expect(
			buildVignetteUniforms({ effectParams: { ...defaultParams(), amount: 50 } })
				.u_amount,
		).toBeCloseTo(0.5);
	});

	test("size maps 0..100 to a 0..0.9 radius", () => {
		expect(
			buildVignetteUniforms({ effectParams: { ...defaultParams(), size: 0 } })
				.u_radius,
		).toBeCloseTo(0);
		expect(
			buildVignetteUniforms({ effectParams: { ...defaultParams(), size: 100 } })
				.u_radius,
		).toBeCloseTo(0.9);
	});

	test("feather maps 0..100 to a 0..0.5 softness", () => {
		expect(
			buildVignetteUniforms({ effectParams: { ...defaultParams(), feather: 100 } })
				.u_feather,
		).toBeCloseTo(0.5);
	});

	test("roundness divides by 100 into 0..1", () => {
		expect(
			buildVignetteUniforms({ effectParams: { ...defaultParams(), roundness: 0 } })
				.u_roundness,
		).toBeCloseTo(0);
		expect(
			buildVignetteUniforms({ effectParams: { ...defaultParams(), roundness: 100 } })
				.u_roundness,
		).toBeCloseTo(1);
	});
});
