import { describe, expect, test } from "bun:test";
import {
	COLOR_ADJUST_SHADER,
	buildColorAdjustPasses,
	buildColorAdjustUniforms,
	colorAdjustEffectDefinition,
	isColorAdjustNeutral,
} from "@/effects/definitions/color-adjust";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";

function defaultParams(): ParamValues {
	return buildDefaultParamValues(colorAdjustEffectDefinition.params);
}

describe("color-adjust definition", () => {
	test("has exactly the 9 documented params with UI ranges", () => {
		const params = colorAdjustEffectDefinition.params;
		expect(params.map((p) => p.key).sort()).toEqual(
			[
				"brightness",
				"contrast",
				"exposure",
				"highlights",
				"saturation",
				"shadows",
				"sharpen",
				"temperature",
				"tint",
			].sort(),
		);

		const byKey = Object.fromEntries(params.map((p) => [p.key, p]));
		expect(byKey.brightness).toMatchObject({ min: -100, max: 100, default: 0 });
		expect(byKey.contrast).toMatchObject({ min: -100, max: 100, default: 0 });
		expect(byKey.saturation).toMatchObject({ min: -100, max: 100, default: 0 });
		expect(byKey.exposure).toMatchObject({
			min: -3,
			max: 3,
			step: 0.05,
			default: 0,
		});
		expect(byKey.temperature).toMatchObject({ min: -100, max: 100, default: 0 });
		expect(byKey.tint).toMatchObject({ min: -100, max: 100, default: 0 });
		expect(byKey.highlights).toMatchObject({ min: -100, max: 100, default: 0 });
		expect(byKey.shadows).toMatchObject({ min: -100, max: 100, default: 0 });
		expect(byKey.sharpen).toMatchObject({ min: 0, max: 100, default: 0 });
	});

	test("all params are keyframable by default (no keyframable: false)", () => {
		for (const param of colorAdjustEffectDefinition.params) {
			expect(param.keyframable).not.toBe(false);
		}
	});
});

describe("isColorAdjustNeutral", () => {
	test("default params are neutral", () => {
		expect(isColorAdjustNeutral({ effectParams: defaultParams() })).toBe(true);
	});

	test("any single non-zero param is not neutral", () => {
		for (const key of [
			"brightness",
			"contrast",
			"saturation",
			"exposure",
			"temperature",
			"tint",
			"highlights",
			"shadows",
			"sharpen",
		]) {
			const params = { ...defaultParams(), [key]: key === "exposure" ? 0.5 : 10 };
			expect(isColorAdjustNeutral({ effectParams: params })).toBe(false);
		}
	});
});

describe("buildColorAdjustPasses", () => {
	test("neutral params resolve to zero passes", () => {
		expect(buildColorAdjustPasses({ effectParams: defaultParams() })).toHaveLength(
			0,
		);
	});

	test("a non-neutral param resolves to exactly one pass on the color-adjust shader", () => {
		const passes = buildColorAdjustPasses({
			effectParams: { ...defaultParams(), brightness: 20 },
		});
		expect(passes).toHaveLength(1);
		expect(passes[0].shader).toBe(COLOR_ADJUST_SHADER);
	});

	test("the single pass carries exactly the 9 schema uniforms", () => {
		const passes = buildColorAdjustPasses({
			effectParams: { ...defaultParams(), contrast: 10 },
		});
		expect(Object.keys(passes[0].uniforms).sort()).toEqual(
			[
				"u_brightness",
				"u_contrast",
				"u_exposure",
				"u_highlights",
				"u_saturation",
				"u_shadows",
				"u_sharpen",
				"u_temperature",
				"u_tint",
			].sort(),
		);
	});
});

describe("buildColorAdjustUniforms UI -> shader mapping", () => {
	test("exposure passes through unchanged (already in stops)", () => {
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), exposure: 1.5 } })
				.u_exposure,
		).toBe(1.5);
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), exposure: -3 } })
				.u_exposure,
		).toBe(-3);
	});

	test("temperature and tint divide by 100 into -1..1", () => {
		const uniforms = buildColorAdjustUniforms({
			effectParams: { ...defaultParams(), temperature: 50, tint: -25 },
		});
		expect(uniforms.u_temperature).toBeCloseTo(0.5);
		expect(uniforms.u_tint).toBeCloseTo(-0.25);
	});

	test("contrast divides by 100 into -1..1", () => {
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), contrast: 100 } })
				.u_contrast,
		).toBeCloseTo(1);
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), contrast: -100 } })
				.u_contrast,
		).toBeCloseTo(-1);
	});

	test("highlights and shadows divide by 100 into -1..1", () => {
		const uniforms = buildColorAdjustUniforms({
			effectParams: { ...defaultParams(), highlights: 80, shadows: -60 },
		});
		expect(uniforms.u_highlights).toBeCloseTo(0.8);
		expect(uniforms.u_shadows).toBeCloseTo(-0.6);
	});

	test("saturation maps -100..100 to a 0..2 multiplier centered on 1", () => {
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), saturation: 0 } })
				.u_saturation,
		).toBeCloseTo(1);
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), saturation: -100 } })
				.u_saturation,
		).toBeCloseTo(0);
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), saturation: 100 } })
				.u_saturation,
		).toBeCloseTo(2);
	});

	test("brightness maps -100..100 to a -0.5..0.5 additive offset", () => {
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), brightness: 100 } })
				.u_brightness,
		).toBeCloseTo(0.5);
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), brightness: -100 } })
				.u_brightness,
		).toBeCloseTo(-0.5);
	});

	test("sharpen maps 0..100 to a 0..2 unsharp amount", () => {
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), sharpen: 0 } })
				.u_sharpen,
		).toBe(0);
		expect(
			buildColorAdjustUniforms({ effectParams: { ...defaultParams(), sharpen: 100 } })
				.u_sharpen,
		).toBeCloseTo(2);
	});

	test("combined: several non-default params map independently", () => {
		const uniforms = buildColorAdjustUniforms({
			effectParams: {
				...defaultParams(),
				brightness: 50,
				contrast: -50,
				saturation: 50,
				exposure: 1,
				temperature: 20,
				tint: -20,
				highlights: 30,
				shadows: -30,
				sharpen: 50,
			},
		});
		expect(uniforms).toEqual({
			u_exposure: 1,
			u_temperature: 0.2,
			u_tint: -0.2,
			u_contrast: -0.5,
			u_highlights: 0.3,
			u_shadows: -0.3,
			u_saturation: 1.5,
			u_brightness: 0.25,
			u_sharpen: 1,
		});
	});
});
