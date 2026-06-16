import { describe, expect, mock, test } from "bun:test";
import type {
	ElementAnimations,
	ScalarAnimationChannel,
} from "@/animation/types";
import type { RectangleMaskParams, SplitMaskParams } from "@/masks/types";

// The resolver transitively imports `@/animation/resolve` →
// `@/animation/interpolation` → `@/wasm`, whose top-level call into the wasm
// binary fails to initialize under `bun test`. Mock `@/wasm` with a pure JS
// stub so we exercise the wasm-free resolution path (linear interpolation never
// touches `mediaTime`; the stub satisfies the import + bezier-handle paths).
mock.module("@/wasm", () => ({
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	TICKS_PER_SECOND: 1_000_000,
}));

const { buildMaskParamPath, hasAnimatedMaskParams, resolveMaskParamsAtTime } =
	await import("../mask-param-channel");

function scalarChannel({
	from,
	to,
	endTime,
}: {
	from: number;
	to: number;
	endTime: number;
}): ScalarAnimationChannel {
	return {
		keys: [
			{
				id: "k0",
				time: 0,
				value: from,
				segmentToNext: "linear",
				tangentMode: "auto",
			},
			{
				id: "k1",
				time: endTime,
				value: to,
				segmentToNext: "linear",
				tangentMode: "auto",
			},
		],
	};
}

function baseRectangleParams(): RectangleMaskParams {
	return {
		feather: 10,
		expand: 0,
		inverted: false,
		strokeColor: "#ffffff",
		strokeWidth: 0,
		strokeAlign: "center",
		centerX: 100,
		centerY: 200,
		width: 400,
		height: 300,
		rotation: 0,
		scale: 1,
	};
}

function baseSplitParams(): SplitMaskParams {
	return {
		feather: 5,
		expand: 0,
		inverted: false,
		strokeColor: "#ffffff",
		strokeWidth: 0,
		strokeAlign: "center",
		centerX: 0,
		centerY: 0,
		rotation: 0,
	};
}

describe("resolveMaskParamsAtTime", () => {
	test("returns the original params reference when there are no animations", () => {
		const params = baseRectangleParams();
		const resolved = resolveMaskParamsAtTime({
			params,
			animations: undefined,
			localTime: 0.5,
		});
		expect(resolved).toBe(params);
	});

	test("returns the original params when no mask.* channels exist", () => {
		const params = baseRectangleParams();
		const animations: ElementAnimations = {
			opacity: scalarChannel({ from: 0, to: 1, endTime: 2 }),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		expect(resolved).toBe(params);
		expect(resolved.feather).toBe(10);
	});

	test("interpolates a 2-keyframe feather animation at a mid time", () => {
		const params = baseRectangleParams();
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "feather" })]: scalarChannel({
				from: 0,
				to: 100,
				endTime: 2,
			}),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		expect(resolved.feather).toBeCloseTo(50, 5);
		// untouched static fields are preserved
		expect(resolved.centerX).toBe(100);
		expect(resolved.scale).toBe(1);
	});

	test("resolves centerX from its channel", () => {
		const params = baseRectangleParams();
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "centerX" })]: scalarChannel({
				from: 0,
				to: 400,
				endTime: 4,
			}),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		expect(resolved.centerX).toBeCloseTo(100, 5);
	});

	test("resolves rotation from its channel", () => {
		const params = baseRectangleParams();
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "rotation" })]: scalarChannel({
				from: 0,
				to: 90,
				endTime: 3,
			}),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		expect(resolved.rotation).toBeCloseTo(30, 5);
	});

	test("resolves scale from its channel", () => {
		const params = baseRectangleParams();
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "scale" })]: scalarChannel({
				from: 1,
				to: 3,
				endTime: 2,
			}),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		expect(resolved.scale).toBeCloseTo(2, 5);
	});

	test("resolves expand from its channel", () => {
		const params = baseRectangleParams();
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "expand" })]: scalarChannel({
				from: 0,
				to: 50,
				endTime: 2,
			}),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		expect(resolved.expand).toBeCloseTo(25, 5);
	});

	test("keeps a field static when only OTHER fields are animated", () => {
		const params = baseRectangleParams();
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "feather" })]: scalarChannel({
				from: 0,
				to: 100,
				endTime: 2,
			}),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		// feather animates, but centerX/centerY/rotation/scale/expand stay static
		expect(resolved.feather).toBeCloseTo(50, 5);
		expect(resolved.centerX).toBe(100);
		expect(resolved.centerY).toBe(200);
		expect(resolved.rotation).toBe(0);
		expect(resolved.scale).toBe(1);
		expect(resolved.expand).toBe(0);
	});

	test("only animates fields the mask type actually carries", () => {
		// A split mask has no `scale`; a stray scale channel must not invent one.
		const params = baseSplitParams();
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "scale" })]: scalarChannel({
				from: 1,
				to: 3,
				endTime: 2,
			}),
			[buildMaskParamPath({ paramKey: "centerX" })]: scalarChannel({
				from: 0,
				to: 200,
				endTime: 2,
			}),
		};
		const resolved = resolveMaskParamsAtTime({
			params,
			animations,
			localTime: 1,
		});
		expect(resolved.centerX).toBeCloseTo(100, 5);
		expect("scale" in resolved).toBe(false);
	});
});

describe("hasAnimatedMaskParams", () => {
	test("false for undefined animations", () => {
		expect(hasAnimatedMaskParams({ animations: undefined })).toBe(false);
	});

	test("false when only non-mask channels exist", () => {
		const animations: ElementAnimations = {
			opacity: scalarChannel({ from: 0, to: 1, endTime: 2 }),
			"params.intensity": scalarChannel({ from: 0, to: 1, endTime: 2 }),
		};
		expect(hasAnimatedMaskParams({ animations })).toBe(false);
	});

	test("true when at least one mask.* channel exists", () => {
		const animations: ElementAnimations = {
			[buildMaskParamPath({ paramKey: "centerY" })]: scalarChannel({
				from: 0,
				to: 100,
				endTime: 2,
			}),
		};
		expect(hasAnimatedMaskParams({ animations })).toBe(true);
	});
});
