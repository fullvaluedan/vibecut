import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import { registerDefaultEffects } from "@/effects/definitions";
import { COLOR_ADJUST_PRESETS } from "@/effects/definitions/color-adjust-presets";
import type { EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

/**
 * Renderer-parity fixture for the Adjust effect, same class as the T18.2
 * curve-renderer-sync test and this crate's own blur-golden.test.ts: it
 * resolves the exact pass list the export path (resolve.ts's
 * resolveEffectPassGroups) and the preview-tile path (effect-preview.ts)
 * would each send to the wasm compositor, through the shared TS
 * resolveEffectPasses entry point, with no GPU involved.
 *
 * Unlike blur, color-adjust's uniforms do not depend on the render target
 * size, so the SAME preset must resolve to byte-identical passes at preview
 * size (160x160) and export size (1920x1080) - that equivalence is the
 * parity property this fixture pins down.
 */
const PREVIEW_SIZE = 160;
const EXPORT_WIDTH = 1920;
const EXPORT_HEIGHT = 1080;

function hashPasses({ passes }: { passes: EffectPass[] }): string {
	const canonical = passes.map((pass) => ({
		shader: pass.shader,
		uniforms: Object.keys(pass.uniforms)
			.sort()
			.map((key) => [key, pass.uniforms[key]] as const),
	}));
	return createHash("md5").update(JSON.stringify(canonical)).digest("hex");
}

function resolveColorAdjustPasses({
	effectParams,
	width,
	height,
}: {
	effectParams: ParamValues;
	width: number;
	height: number;
}): EffectPass[] {
	const definition = effectsRegistry.get("color-adjust");
	return resolveEffectPasses({ definition, effectParams, width, height });
}

describe("color-adjust golden (renderer-parity fixture)", () => {
	beforeAll(() => {
		if (!effectsRegistry.has("color-adjust")) registerDefaultEffects();
	});

	test("preview-tile and export-frame pass lists are byte-identical for every preset", () => {
		for (const preset of COLOR_ADJUST_PRESETS) {
			const previewPasses = resolveColorAdjustPasses({
				effectParams: preset.params,
				width: PREVIEW_SIZE,
				height: PREVIEW_SIZE,
			});
			const exportPasses = resolveColorAdjustPasses({
				effectParams: preset.params,
				width: EXPORT_WIDTH,
				height: EXPORT_HEIGHT,
			});
			expect(hashPasses({ passes: exportPasses })).toBe(
				hashPasses({ passes: previewPasses }),
			);
		}
	});

	test("every preset resolves to exactly one color-adjust pass carrying all 9 uniforms", () => {
		for (const preset of COLOR_ADJUST_PRESETS) {
			const passes = resolveColorAdjustPasses({
				effectParams: preset.params,
				width: EXPORT_WIDTH,
				height: EXPORT_HEIGHT,
			});
			expect(passes).toHaveLength(1);
			expect(passes[0].shader).toBe("color-adjust");
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
		}
	});

	test("Vivid preset export-frame pass list is unchanged (regression golden)", () => {
		const vivid = COLOR_ADJUST_PRESETS.find((preset) => preset.id === "vivid");
		if (!vivid) throw new Error("Vivid preset missing");
		const passes = resolveColorAdjustPasses({
			effectParams: vivid.params,
			width: EXPORT_WIDTH,
			height: EXPORT_HEIGHT,
		});
		expect(hashPasses({ passes })).toBe("77b473290244125d56da88a851f83e87");
	});

	test("a neutral Adjust instance resolves to zero passes at both sizes", () => {
		const neutralParams: ParamValues = {
			brightness: 0,
			contrast: 0,
			saturation: 0,
			exposure: 0,
			temperature: 0,
			tint: 0,
			highlights: 0,
			shadows: 0,
			sharpen: 0,
		};
		expect(
			resolveColorAdjustPasses({
				effectParams: neutralParams,
				width: PREVIEW_SIZE,
				height: PREVIEW_SIZE,
			}),
		).toHaveLength(0);
		expect(
			resolveColorAdjustPasses({
				effectParams: neutralParams,
				width: EXPORT_WIDTH,
				height: EXPORT_HEIGHT,
			}),
		).toHaveLength(0);
	});
});
