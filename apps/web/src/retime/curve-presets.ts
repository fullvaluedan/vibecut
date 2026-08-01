import { normalizeRetimeCurve, type RetimeCurve, type RetimeCurvePoint } from "@/retime/curve";

export interface RetimeCurvePreset {
	id: string;
	label: string;
	points: RetimeCurvePoint[];
}

/** The "start editing" preset: a flat 1x curve with one movable interior
 * point, so picking it hands the user a blank canvas rather than a
 * pre-shaped one. Distinguished from the other six, which are fixed CapCut
 * shape stamps. */
export const CUSTOM_CURVE_PRESET_ID = "custom";

/**
 * CapCut's seven speed-curve presets, approximated as named piecewise-linear
 * point sets. Every preset stays inside `[MIN_RETIME_RATE, MAX_RETIME_RATE]`
 * (0.01..5) and within the 2..10 point budget; shapes are documented inline
 * since there's no first-party spec to match exactly against, only CapCut's
 * observed on-screen behavior.
 */
export const RETIME_CURVE_PRESETS: RetimeCurvePreset[] = [
	{
		id: CUSTOM_CURVE_PRESET_ID,
		label: "Custom",
		// Flat 1x with one free interior point - a neutral starting shape for
		// hand-drawing a curve from scratch.
		points: [
			{ t: 0, rate: 1 },
			{ t: 0.5, rate: 1 },
			{ t: 1, rate: 1 },
		],
	},
	{
		id: "montage",
		label: "Montage",
		// Alternating slow/fast bursts: the highlight-reel rhythm CapCut's
		// Montage preset gives a clip - dips to half speed then snaps to 2x,
		// twice, so the clip reads as a series of punchy beats rather than one
		// smooth ramp.
		points: [
			{ t: 0, rate: 0.5 },
			{ t: 0.2, rate: 2 },
			{ t: 0.4, rate: 0.5 },
			{ t: 0.6, rate: 2 },
			{ t: 0.8, rate: 0.5 },
			{ t: 1, rate: 2 },
		],
	},
	{
		id: "hero",
		label: "Hero",
		// Slow-fast-slow: a dramatic build (slow start), a fast "hero moment"
		// burst through the middle, then slows again to let it land.
		points: [
			{ t: 0, rate: 0.3 },
			{ t: 0.3, rate: 0.3 },
			{ t: 0.5, rate: 3 },
			{ t: 0.7, rate: 0.3 },
			{ t: 1, rate: 0.3 },
		],
	},
	{
		id: "bullet",
		label: "Bullet",
		// Fast-slow-fast: the mirror of Hero, and the classic "bullet time"
		// shape - normal-to-fast pace on either side of a sudden slow-motion
		// beat in the middle.
		points: [
			{ t: 0, rate: 3 },
			{ t: 0.3, rate: 3 },
			{ t: 0.5, rate: 0.2 },
			{ t: 0.7, rate: 3 },
			{ t: 1, rate: 3 },
		],
	},
	{
		id: "jump-cut",
		label: "Jump Cut",
		// Stepped, abrupt speed jumps rather than a smooth ramp - a piecewise-
		// linear curve can't represent a true discontinuity, so adjacent points
		// sit a hair apart in `t` to fake a near-vertical jump between two rate
		// plateaus, twice.
		points: [
			{ t: 0, rate: 1 },
			{ t: 0.15, rate: 1 },
			{ t: 0.16, rate: 4 },
			{ t: 0.4, rate: 4 },
			{ t: 0.41, rate: 1 },
			{ t: 0.7, rate: 1 },
			{ t: 0.71, rate: 4 },
			{ t: 1, rate: 4 },
		],
	},
	{
		id: "flash-in",
		label: "Flash In",
		// Fast start easing to 1x: a quick speed-up right out of the gate that
		// settles back to normal pace for the rest of the clip.
		points: [
			{ t: 0, rate: 4 },
			{ t: 0.25, rate: 1 },
			{ t: 1, rate: 1 },
		],
	},
	{
		id: "flash-out",
		label: "Flash Out",
		// Mirror of Flash In: holds 1x, then flashes fast right at the end.
		points: [
			{ t: 0, rate: 1 },
			{ t: 0.75, rate: 1 },
			{ t: 1, rate: 4 },
		],
	},
];

export function getRetimeCurvePreset({
	id,
}: {
	id: string;
}): RetimeCurvePreset | undefined {
	return RETIME_CURVE_PRESETS.find((preset) => preset.id === id);
}

/** Builds a ready-to-use, validated `RetimeCurve` from a preset id. Falls
 * back to the Custom (flat 1x) shape for an unknown id so a stale/renamed
 * preset id never produces an invalid curve. */
export function buildRetimeCurveFromPreset({ id }: { id: string }): RetimeCurve {
	const preset = getRetimeCurvePreset({ id }) ?? RETIME_CURVE_PRESETS[0];
	return normalizeRetimeCurve({ points: preset.points });
}
