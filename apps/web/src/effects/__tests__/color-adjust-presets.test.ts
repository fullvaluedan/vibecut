import { describe, expect, test } from "bun:test";
import { COLOR_ADJUST_PRESETS } from "@/effects/definitions/color-adjust-presets";
import {
	COLOR_ADJUST_PARAM_KEYS,
	colorAdjustEffectDefinition,
	isColorAdjustNeutral,
} from "@/effects/definitions/color-adjust";

describe("COLOR_ADJUST_PRESETS", () => {
	test("ships exactly 8 presets with the documented names", () => {
		expect(COLOR_ADJUST_PRESETS.map((preset) => preset.name)).toEqual([
			"Vivid",
			"Film",
			"Mono",
			"Warm",
			"Cool",
			"Fade",
			"Punch",
			"Golden",
		]);
	});

	test("every preset id is unique", () => {
		const ids = COLOR_ADJUST_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every preset sets all 9 param keys and only registered keys", () => {
		const paramKeys = new Set(colorAdjustEffectDefinition.params.map((p) => p.key));
		for (const preset of COLOR_ADJUST_PRESETS) {
			expect(Object.keys(preset.params).sort()).toEqual(
				[...COLOR_ADJUST_PARAM_KEYS].sort(),
			);
			for (const key of Object.keys(preset.params)) {
				expect(paramKeys.has(key)).toBe(true);
			}
		}
	});

	test("every preset value is within its param's declared min/max", () => {
		const byKey = Object.fromEntries(
			colorAdjustEffectDefinition.params.map((p) => [p.key, p]),
		);
		for (const preset of COLOR_ADJUST_PRESETS) {
			for (const [key, value] of Object.entries(preset.params)) {
				const param = byKey[key];
				expect(param.type).toBe("number");
				if (param.type === "number") {
					expect(value).toBeGreaterThanOrEqual(param.min);
					if (param.max !== undefined) {
						expect(value).toBeLessThanOrEqual(param.max);
					}
				}
			}
		}
	});

	test("every preset is non-neutral (a preset always changes the look)", () => {
		for (const preset of COLOR_ADJUST_PRESETS) {
			expect(isColorAdjustNeutral({ effectParams: preset.params })).toBe(false);
		}
	});

	test("Vivid preset boosts saturation, contrast and brightness", () => {
		const vivid = COLOR_ADJUST_PRESETS.find((preset) => preset.id === "vivid");
		expect(vivid?.params).toMatchObject({
			saturation: 40,
			contrast: 20,
			brightness: 5,
		});
	});

	test("Mono preset fully desaturates", () => {
		const mono = COLOR_ADJUST_PRESETS.find((preset) => preset.id === "mono");
		expect(mono?.params.saturation).toBe(-100);
	});

	test("Warm and Cool presets push temperature in opposite directions", () => {
		const warm = COLOR_ADJUST_PRESETS.find((preset) => preset.id === "warm");
		const cool = COLOR_ADJUST_PRESETS.find((preset) => preset.id === "cool");
		expect(warm?.params.temperature).toBeGreaterThan(0);
		expect(cool?.params.temperature).toBeLessThan(0);
	});
});
