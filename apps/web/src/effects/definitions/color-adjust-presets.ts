import type { ColorAdjustParamValues } from "./color-adjust";

/**
 * Filter presets for the Adjust effect: full param bundles (every one of the
 * 9 params is set explicitly, including 0 for params the look does not use)
 * so applying a preset always fully replaces the prior look rather than
 * merging on top of it.
 */
export interface ColorAdjustPreset {
	id: string;
	name: string;
	params: ColorAdjustParamValues;
}

const NEUTRAL: ColorAdjustParamValues = {
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

export const COLOR_ADJUST_PRESETS: ColorAdjustPreset[] = [
	{
		id: "vivid",
		name: "Vivid",
		params: { ...NEUTRAL, saturation: 40, contrast: 20, brightness: 5 },
	},
	{
		id: "film",
		name: "Film",
		params: {
			...NEUTRAL,
			contrast: 10,
			saturation: -15,
			highlights: -10,
			shadows: 15,
			temperature: 8,
		},
	},
	{
		id: "mono",
		name: "Mono",
		params: { ...NEUTRAL, saturation: -100, contrast: 10 },
	},
	{
		id: "warm",
		name: "Warm",
		params: { ...NEUTRAL, temperature: 35, tint: 5, brightness: 3 },
	},
	{
		id: "cool",
		name: "Cool",
		params: { ...NEUTRAL, temperature: -35, tint: -5 },
	},
	{
		id: "fade",
		name: "Fade",
		params: {
			...NEUTRAL,
			contrast: -25,
			shadows: 20,
			saturation: -20,
			brightness: 5,
		},
	},
	{
		id: "punch",
		name: "Punch",
		params: { ...NEUTRAL, contrast: 35, saturation: 25, sharpen: 20 },
	},
	{
		id: "golden",
		name: "Golden",
		params: {
			...NEUTRAL,
			temperature: 30,
			tint: 10,
			saturation: 10,
			highlights: -10,
			shadows: 10,
		},
	},
];
