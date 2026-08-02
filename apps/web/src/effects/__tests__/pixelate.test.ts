import { describe, expect, test } from "bun:test";
import {
	PIXELATE_SHADER,
	blockSizeToPixels,
	buildPixelatePasses,
	isPixelateNeutral,
	pixelateEffectDefinition,
} from "@/effects/definitions/pixelate";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";

function defaultParams(): ParamValues {
	return buildDefaultParamValues(pixelateEffectDefinition.params);
}

describe("pixelate definition", () => {
	test("has exactly the documented blockSize param", () => {
		expect(pixelateEffectDefinition.params.map((p) => p.key)).toEqual([
			"blockSize",
		]);
		expect(pixelateEffectDefinition.params[0]).toMatchObject({
			min: 1,
			max: 100,
			default: 1,
		});
	});

	test("blockSize is keyframable by default", () => {
		expect(pixelateEffectDefinition.params[0].keyframable).not.toBe(false);
	});
});

describe("isPixelateNeutral", () => {
	test("the default (blockSize=1) is neutral", () => {
		expect(isPixelateNeutral({ effectParams: defaultParams() })).toBe(true);
	});

	test("any blockSize above 1 is not neutral", () => {
		expect(
			isPixelateNeutral({ effectParams: { blockSize: 2 } }),
		).toBe(false);
		expect(
			isPixelateNeutral({ effectParams: { blockSize: 100 } }),
		).toBe(false);
	});
});

describe("blockSizeToPixels", () => {
	test("scales linearly with render width against the 1920 reference", () => {
		expect(blockSizeToPixels({ blockSize: 10, width: 1920 })).toBeCloseTo(10);
		expect(blockSizeToPixels({ blockSize: 10, width: 3840 })).toBeCloseTo(20);
		expect(blockSizeToPixels({ blockSize: 10, width: 960 })).toBeCloseTo(5);
	});

	test("never returns less than 1px", () => {
		expect(blockSizeToPixels({ blockSize: 1, width: 100 })).toBeGreaterThanOrEqual(1);
	});
});

describe("buildPixelatePasses", () => {
	test("neutral params resolve to zero passes", () => {
		expect(
			buildPixelatePasses({ effectParams: defaultParams(), width: 1920 }),
		).toHaveLength(0);
	});

	test("a non-neutral blockSize resolves to exactly one pass on the pixelate shader", () => {
		const passes = buildPixelatePasses({
			effectParams: { blockSize: 20 },
			width: 1920,
		});
		expect(passes).toHaveLength(1);
		expect(passes[0].shader).toBe(PIXELATE_SHADER);
		expect(Object.keys(passes[0].uniforms)).toEqual(["u_block_size"]);
		expect(passes[0].uniforms.u_block_size).toBeCloseTo(20);
	});

	test("resolution scaling flows through buildPasses", () => {
		const passes = buildPixelatePasses({
			effectParams: { blockSize: 10 },
			width: 3840,
		});
		expect(passes[0].uniforms.u_block_size).toBeCloseTo(20);
	});
});
