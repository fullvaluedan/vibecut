import { describe, expect, test } from "bun:test";
import {
	buildTextShadowFromElement,
	buildTextStrokeFromElement,
} from "@/text/measure-element";
import { DEFAULTS } from "@/timeline/defaults";
import type { TextElement } from "@/timeline";

/**
 * U3 (text round): the pure param->resolved-value builders that feed the
 * text render path (services/renderer/resolve.ts's resolveTextNode calls
 * these directly, mirroring the existing buildTextBackgroundFromElement).
 */

function buildElement(paramOverrides: Record<string, unknown> = {}): TextElement {
	return {
		...DEFAULTS.text.element,
		id: "el-1",
		params: {
			...DEFAULTS.text.element.params,
			...paramOverrides,
		},
	} as TextElement;
}

describe("buildTextStrokeFromElement", () => {
	test("a brand-new element (no overrides) resolves to the inert defaults", () => {
		const element = buildElement();
		expect(buildTextStrokeFromElement({ element })).toEqual({
			color: DEFAULTS.text.stroke.color,
			width: 0,
		});
	});

	test("falls back to defaults when the params object is missing the keys entirely", () => {
		const element = { ...buildElement(), params: {} } as TextElement;
		expect(buildTextStrokeFromElement({ element })).toEqual({
			color: DEFAULTS.text.stroke.color,
			width: DEFAULTS.text.stroke.width,
		});
	});

	test("reads a custom stroke color/width param set", () => {
		const element = buildElement({ strokeColor: "#00ff00", strokeWidth: 4 });
		expect(buildTextStrokeFromElement({ element })).toEqual({
			color: "#00ff00",
			width: 4,
		});
	});
});

describe("buildTextShadowFromElement", () => {
	test("a brand-new element (no overrides) resolves to the inert defaults", () => {
		const element = buildElement();
		expect(buildTextShadowFromElement({ element })).toEqual({
			color: DEFAULTS.text.shadow.color,
			blur: 0,
			offsetX: 0,
			offsetY: 0,
		});
	});

	test("falls back to defaults when the params object is missing the keys entirely", () => {
		const element = { ...buildElement(), params: {} } as TextElement;
		expect(buildTextShadowFromElement({ element })).toEqual({
			color: DEFAULTS.text.shadow.color,
			blur: DEFAULTS.text.shadow.blur,
			offsetX: DEFAULTS.text.shadow.offsetX,
			offsetY: DEFAULTS.text.shadow.offsetY,
		});
	});

	test("reads a custom shadow param set - this is the render descriptor U3 wires into drawMeasuredTextLayout", () => {
		const element = buildElement({
			shadowColor: "#123456",
			shadowBlur: 8,
			shadowOffsetX: 3,
			shadowOffsetY: -3,
		});
		expect(buildTextShadowFromElement({ element })).toEqual({
			color: "#123456",
			blur: 8,
			offsetX: 3,
			offsetY: -3,
		});
	});
});

describe("defaults are inert (existing projects render byte-identically)", () => {
	test("DEFAULTS.text.stroke has zero width", () => {
		expect(DEFAULTS.text.stroke.width).toBe(0);
	});

	test("DEFAULTS.text.shadow has zero blur and zero offsets", () => {
		expect(DEFAULTS.text.shadow.blur).toBe(0);
		expect(DEFAULTS.text.shadow.offsetX).toBe(0);
		expect(DEFAULTS.text.shadow.offsetY).toBe(0);
	});

	test("a brand-new text element's default params carry the inert stroke/shadow values", () => {
		expect(DEFAULTS.text.element.params.strokeWidth).toBe(0);
		expect(DEFAULTS.text.element.params.shadowBlur).toBe(0);
		expect(DEFAULTS.text.element.params.shadowOffsetX).toBe(0);
		expect(DEFAULTS.text.element.params.shadowOffsetY).toBe(0);
	});
});
