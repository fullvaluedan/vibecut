import { describe, expect, test } from "bun:test";
import {
	GLOW_SHADER,
	buildGlowPasses,
	glowEffectDefinition,
	isGlowNeutral,
} from "@/effects/definitions/glow";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";

function defaultParams(): ParamValues {
	return buildDefaultParamValues(glowEffectDefinition.params);
}

describe("glow definition", () => {
	test("has exactly the 3 documented params", () => {
		expect(glowEffectDefinition.params.map((p) => p.key).sort()).toEqual(
			["intensity", "radius", "threshold"].sort(),
		);
	});

	test("intensity defaults to 0 (identity)", () => {
		const byKey = Object.fromEntries(
			glowEffectDefinition.params.map((p) => [p.key, p]),
		);
		expect(byKey.intensity).toMatchObject({ min: 0, max: 100, default: 0 });
	});

	test("all params are keyframable by default", () => {
		for (const param of glowEffectDefinition.params) {
			expect(param.keyframable).not.toBe(false);
		}
	});
});

describe("isGlowNeutral", () => {
	test("the default (intensity=0) is neutral", () => {
		expect(isGlowNeutral({ effectParams: defaultParams() })).toBe(true);
	});

	test("any positive intensity is not neutral", () => {
		expect(
			isGlowNeutral({ effectParams: { ...defaultParams(), intensity: 1 } }),
		).toBe(false);
	});
});

describe("buildGlowPasses pass-chain shape", () => {
	test("neutral params resolve to zero passes", () => {
		expect(
			buildGlowPasses({ effectParams: defaultParams(), width: 1920, height: 1080 }),
		).toHaveLength(0);
	});

	/**
	 * The core architectural fact this test pins down: glow is a SEPARABLE
	 * 2-pass filter (horizontal then vertical) on the gaussian-blur shader,
	 * NOT a bright-pass-extract -> blur -> combine-with-original chain. See
	 * glow.wgsl's top comment for why: apply_with_encoder only ever hands a
	 * pass the PREVIOUS pass's output, so a true additive combine against the
	 * untouched original is not expressible without changing that shared
	 * chaining contract. Each pass here instead adds its own bloom
	 * contribution to its own input, so pass 2 already carries pass 1's
	 * output forward - no separate combine pass, no second texture bind.
	 */
	test("a non-neutral intensity resolves to exactly 2 passes, horizontal then vertical, both on the glow shader", () => {
		const passes = buildGlowPasses({
			effectParams: { ...defaultParams(), intensity: 50 },
			width: 1920,
			height: 1080,
		});
		expect(passes).toHaveLength(2);
		expect(passes[0].shader).toBe(GLOW_SHADER);
		expect(passes[1].shader).toBe(GLOW_SHADER);
		expect(passes[0].uniforms.u_direction).toEqual([1, 0]);
		expect(passes[1].uniforms.u_direction).toEqual([0, 1]);
	});

	test("every pass carries exactly the 4 schema uniforms", () => {
		const passes = buildGlowPasses({
			effectParams: { ...defaultParams(), intensity: 50 },
			width: 1920,
			height: 1080,
		});
		for (const pass of passes) {
			expect(Object.keys(pass.uniforms).sort()).toEqual(
				["u_direction", "u_intensity", "u_radius", "u_threshold"].sort(),
			);
		}
	});

	test("threshold and intensity map into their documented shader-space ranges", () => {
		const passes = buildGlowPasses({
			effectParams: { threshold: 100, intensity: 100, radius: 50 },
			width: 1920,
			height: 1080,
		});
		expect(passes[0].uniforms.u_threshold).toBeCloseTo(1);
		expect(passes[0].uniforms.u_intensity).toBeCloseTo(1.5);
	});

	test("radius scales per axis using the render dimensions (mirrors blur's H/V asymmetry)", () => {
		const wide = buildGlowPasses({
			effectParams: { ...defaultParams(), intensity: 50 },
			width: 3840,
			height: 1080,
		});
		// Horizontal pass radius scales with width, vertical with height, so a
		// non-square target produces different per-pass radii.
		expect(wide[0].uniforms.u_radius).not.toBeCloseTo(
			wide[1].uniforms.u_radius as number,
		);
	});
});
