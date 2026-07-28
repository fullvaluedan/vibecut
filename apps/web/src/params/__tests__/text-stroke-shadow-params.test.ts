import { describe, expect, test } from "bun:test";
import { getBuiltInElementParams } from "@/params/registry";
import { DEFAULTS } from "@/timeline/defaults";

/**
 * U3 (text round): the six new text params (strokeColor/strokeWidth/
 * shadowColor/shadowBlur/shadowOffsetX/shadowOffsetY) must default to fully
 * inert values so an existing project - which has never set these params and
 * so always falls through to `param.default` - renders byte-identically to
 * before this round shipped.
 */

const STROKE_SHADOW_KEYS = [
	"strokeColor",
	"strokeWidth",
	"shadowColor",
	"shadowBlur",
	"shadowOffsetX",
	"shadowOffsetY",
] as const;

function findParam(key: string) {
	return getBuiltInElementParams({ type: "text" }).find((p) => p.key === key);
}

describe("text stroke/shadow param definitions", () => {
	test("all six params are registered on the text element type", () => {
		for (const key of STROKE_SHADOW_KEYS) {
			expect(findParam(key)).toBeDefined();
		}
	});

	test("strokeWidth defaults to 0 (inert)", () => {
		expect(findParam("strokeWidth")?.default).toBe(0);
		expect(findParam("strokeWidth")?.default).toBe(DEFAULTS.text.stroke.width);
	});

	test("shadowBlur/shadowOffsetX/shadowOffsetY all default to 0 (inert)", () => {
		expect(findParam("shadowBlur")?.default).toBe(0);
		expect(findParam("shadowOffsetX")?.default).toBe(0);
		expect(findParam("shadowOffsetY")?.default).toBe(0);
	});

	test("none of the six are keyframable (a static per-element look, mirrors background.enabled/muted)", () => {
		for (const key of STROKE_SHADOW_KEYS) {
			expect(findParam(key)?.keyframable).toBe(false);
		}
	});

	test("strokeWidth and shadowBlur are bounded (min+max), so PropertyParamField renders them as SliderNumberPair", () => {
		const strokeWidth = findParam("strokeWidth");
		const shadowBlur = findParam("shadowBlur");
		expect(strokeWidth?.type).toBe("number");
		expect(shadowBlur?.type).toBe("number");
		if (strokeWidth?.type === "number") {
			expect(strokeWidth.max).toBeDefined();
		}
		if (shadowBlur?.type === "number") {
			expect(shadowBlur.max).toBeDefined();
		}
	});

	test("shadowOffsetX/shadowOffsetY are unbounded (no max), so PropertyParamField renders them as a plain NumberField", () => {
		const offsetX = findParam("shadowOffsetX");
		const offsetY = findParam("shadowOffsetY");
		if (offsetX?.type === "number") {
			expect(offsetX.max).toBeUndefined();
		}
		if (offsetY?.type === "number") {
			expect(offsetY.max).toBeUndefined();
		}
	});
});
