import { describe, expect, test } from "bun:test";
import {
	CUSTOM_CURVE_PRESET_ID,
	RETIME_CURVE_PRESETS,
	buildRetimeCurveFromPreset,
	getRetimeCurvePreset,
} from "@/retime/curve-presets";
import { isValidRetimeCurve } from "@/retime/curve";
import { buildCurveRetimeFromPoints, buildCurveRetimeFromPreset } from "@/retime/presets";
import { DEFAULT_RETIME_RATE } from "@/retime/rate";

describe("CapCut speed-curve presets", () => {
	test("ships exactly the seven CapCut presets, Custom first", () => {
		expect(RETIME_CURVE_PRESETS).toHaveLength(7);
		expect(RETIME_CURVE_PRESETS[0].id).toBe(CUSTOM_CURVE_PRESET_ID);
		expect(RETIME_CURVE_PRESETS.map((preset) => preset.label)).toEqual([
			"Custom",
			"Montage",
			"Hero",
			"Bullet",
			"Jump Cut",
			"Flash In",
			"Flash Out",
		]);
	});

	test("every preset's raw points normalize into a valid curve", () => {
		for (const preset of RETIME_CURVE_PRESETS) {
			const curve = buildRetimeCurveFromPreset({ id: preset.id });
			expect(isValidRetimeCurve({ curve })).toBe(true);
		}
	});

	test("every preset id resolves via getRetimeCurvePreset", () => {
		for (const preset of RETIME_CURVE_PRESETS) {
			expect(getRetimeCurvePreset({ id: preset.id })?.label).toBe(preset.label);
		}
	});

	test("an unknown preset id falls back to the Custom shape rather than throwing", () => {
		const curve = buildRetimeCurveFromPreset({ id: "not-a-real-preset" });
		expect(isValidRetimeCurve({ curve })).toBe(true);
		expect(curve).toEqual(buildRetimeCurveFromPreset({ id: CUSTOM_CURVE_PRESET_ID }));
	});

	test("Hero is slow-fast-slow: middle rate exceeds both shoulders", () => {
		const hero = getRetimeCurvePreset({ id: "hero" })!;
		const middle = hero.points.find((p) => p.t === 0.5)!;
		const start = hero.points[0];
		const end = hero.points[hero.points.length - 1];
		expect(middle.rate).toBeGreaterThan(start.rate);
		expect(middle.rate).toBeGreaterThan(end.rate);
	});

	test("Bullet is fast-slow-fast: middle rate is below both shoulders", () => {
		const bullet = getRetimeCurvePreset({ id: "bullet" })!;
		const middle = bullet.points.find((p) => p.t === 0.5)!;
		const start = bullet.points[0];
		const end = bullet.points[bullet.points.length - 1];
		expect(middle.rate).toBeLessThan(start.rate);
		expect(middle.rate).toBeLessThan(end.rate);
	});

	test("Flash In starts fast and eases to 1x", () => {
		const flashIn = getRetimeCurvePreset({ id: "flash-in" })!;
		expect(flashIn.points[0].rate).toBeGreaterThan(1);
		expect(flashIn.points[flashIn.points.length - 1].rate).toBe(1);
	});

	test("Flash Out is the mirror of Flash In: holds 1x then flashes fast at the end", () => {
		const flashOut = getRetimeCurvePreset({ id: "flash-out" })!;
		expect(flashOut.points[0].rate).toBe(1);
		expect(flashOut.points[flashOut.points.length - 1].rate).toBeGreaterThan(1);
	});
});

describe("swapping presets (retime/presets.ts builders)", () => {
	test("buildCurveRetimeFromPreset produces a forward, vestigial-rate retime carrying the curve", () => {
		const retime = buildCurveRetimeFromPreset({ presetId: "hero" });
		expect(retime.rate).toBe(DEFAULT_RETIME_RATE);
		expect(retime.reversed).toBeUndefined();
		expect(retime.curve).toBeDefined();
		expect(isValidRetimeCurve({ curve: retime.curve! })).toBe(true);
	});

	test("swapping from one preset to another replaces the curve cleanly (no leftover points)", () => {
		const hero = buildCurveRetimeFromPreset({ presetId: "hero" });
		const bullet = buildCurveRetimeFromPreset({ presetId: "bullet" });
		expect(hero.curve!.points).not.toEqual(bullet.curve!.points);
		expect(bullet.curve!.points).toEqual(
			buildRetimeCurveFromPreset({ id: "bullet" }).points,
		);
	});

	test("buildCurveRetimeFromPoints sanitizes a freely-edited (custom) point list", () => {
		const retime = buildCurveRetimeFromPoints({
			points: [
				{ t: 0.4, rate: 2 },
				{ t: 0.1, rate: 0.5 },
			],
		});
		expect(isValidRetimeCurve({ curve: retime.curve! })).toBe(true);
	});

	test("maintainPitch carries through preset builds", () => {
		const retime = buildCurveRetimeFromPreset({ presetId: "montage", maintainPitch: true });
		expect(retime.maintainPitch).toBe(true);
	});
});
