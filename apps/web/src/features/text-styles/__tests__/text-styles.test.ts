import { describe, expect, it } from "bun:test";
import type { ParamValue } from "@/params";
import type { TextElement } from "@/timeline";
import {
	addTextStyle,
	findTextStyle,
	normalizeTextStyles,
	readTextStyles,
	removeTextStyle,
} from "../project-styles";
import {
	TEXT_STYLE_PARAM_KEYS,
	buildTextStylePatch,
	captureTextStyleParams,
	getTextStyleParamDefaults,
	isTextStyleParamKey,
} from "../style-params";
import type { TextStyle } from "../types";

/**
 * U2: the appearance/content split is the load-bearing rule of text styles, so
 * most of this file is about what a style DOES NOT carry. The React surface
 * (Section, Select, inline naming) is browser-only; these tests cover the pure
 * capture / patch / persistence-shape layer underneath it.
 */

function buildElement({
	params,
}: {
	params: Record<string, ParamValue>;
}): Pick<TextElement, "params"> {
	return { params };
}

const STYLED_PARAMS: Record<string, ParamValue> = {
	content: "Hello from the tutorial",
	fontFamily: "Inter",
	fontSize: 48,
	fontWeight: "bold",
	fontStyle: "italic",
	textDecoration: "underline",
	color: "#ff8800",
	letterSpacing: 2,
	lineHeight: 1.4,
	textAlign: "left",
	"background.enabled": true,
	"background.color": "#101010",
	"background.cornerRadius": 12,
	"background.paddingX": 24,
	"background.paddingY": 16,
	"background.offsetX": 5,
	"background.offsetY": -5,
	"transform.positionX": 300,
	"transform.positionY": -420,
	"transform.scaleX": 1.5,
	"transform.scaleY": 1.5,
	"transform.rotate": 12,
	opacity: 0.6,
	blendMode: "screen",
};

describe("captureTextStyleParams", () => {
	it("captures every appearance param off the element", () => {
		const captured = captureTextStyleParams({
			element: buildElement({ params: STYLED_PARAMS }),
		});

		expect(captured.fontFamily).toBe("Inter");
		expect(captured.fontSize).toBe(48);
		expect(captured.fontWeight).toBe("bold");
		expect(captured.fontStyle).toBe("italic");
		expect(captured.textDecoration).toBe("underline");
		expect(captured.color).toBe("#ff8800");
		expect(captured.letterSpacing).toBe(2);
		expect(captured.lineHeight).toBe(1.4);
		expect(captured.textAlign).toBe("left");
		expect(captured["background.enabled"]).toBe(true);
		expect(captured["background.color"]).toBe("#101010");
		expect(captured["background.cornerRadius"]).toBe(12);
		expect(captured["background.paddingX"]).toBe(24);
		expect(captured["background.paddingY"]).toBe(16);
		expect(captured["background.offsetX"]).toBe(5);
		expect(captured["background.offsetY"]).toBe(-5);
	});

	it("captures the appearance keys and NOTHING else", () => {
		const captured = captureTextStyleParams({
			element: buildElement({ params: STYLED_PARAMS }),
		});

		expect(Object.keys(captured).sort()).toEqual(
			[...TEXT_STYLE_PARAM_KEYS].sort(),
		);
	});

	it("never captures content, position, scale, rotation, opacity or blend", () => {
		const captured = captureTextStyleParams({
			element: buildElement({ params: STYLED_PARAMS }),
		});

		for (const forbidden of [
			"content",
			"transform.positionX",
			"transform.positionY",
			"transform.scaleX",
			"transform.scaleY",
			"transform.rotate",
			"opacity",
			"blendMode",
		]) {
			expect(captured[forbidden]).toBeUndefined();
			expect(isTextStyleParamKey({ key: forbidden })).toBe(false);
		}
	});

	it("fills gaps with registry defaults so a style is a COMPLETE look", () => {
		const captured = captureTextStyleParams({
			element: buildElement({ params: { content: "bare", fontSize: 90 } }),
		});
		const defaults = getTextStyleParamDefaults();

		expect(captured.fontSize).toBe(90);
		expect(captured.fontFamily).toBe(defaults.fontFamily);
		expect(captured["background.enabled"]).toBe(defaults["background.enabled"]);
		expect(Object.keys(captured).sort()).toEqual(
			[...TEXT_STYLE_PARAM_KEYS].sort(),
		);
	});
});

describe("buildTextStylePatch", () => {
	const style: TextStyle = {
		id: "style-1",
		name: "Lower third",
		params: captureTextStyleParams({
			element: buildElement({ params: STYLED_PARAMS }),
		}),
		createdAt: "2026-07-21T00:00:00.000Z",
	};

	it("overwrites the target's appearance params", () => {
		const target = buildElement({
			params: {
				content: "Chapter two",
				fontFamily: "Arial",
				fontSize: 15,
				color: "#ffffff",
				"background.enabled": false,
			},
		});

		const patch = buildTextStylePatch({ element: target, style });

		expect(patch.params.fontFamily).toBe("Inter");
		expect(patch.params.fontSize).toBe(48);
		expect(patch.params.color).toBe("#ff8800");
		expect(patch.params["background.enabled"]).toBe(true);
	});

	it("leaves content, position, scale and rotation exactly as they were", () => {
		const target = buildElement({
			params: {
				content: "Chapter two",
				"transform.positionX": -800,
				"transform.positionY": 640,
				"transform.scaleX": 0.25,
				"transform.scaleY": 0.25,
				"transform.rotate": -3,
				opacity: 0.5,
				blendMode: "multiply",
			},
		});

		const patch = buildTextStylePatch({ element: target, style });

		expect(patch.params.content).toBe("Chapter two");
		expect(patch.params["transform.positionX"]).toBe(-800);
		expect(patch.params["transform.positionY"]).toBe(640);
		expect(patch.params["transform.scaleX"]).toBe(0.25);
		expect(patch.params["transform.scaleY"]).toBe(0.25);
		expect(patch.params["transform.rotate"]).toBe(-3);
		expect(patch.params.opacity).toBe(0.5);
		expect(patch.params.blendMode).toBe("multiply");
	});

	it("does not mutate the element it patches", () => {
		const params = { content: "Chapter two", fontSize: 15 };
		const target = buildElement({ params });

		buildTextStylePatch({ element: target, style });

		expect(params.fontSize).toBe(15);
	});

	it("is sane on an element whose params are missing entirely", () => {
		const patch = buildTextStylePatch({
			element: buildElement({ params: {} }),
			style,
		});

		expect(patch.params.fontFamily).toBe("Inter");
		expect(Object.keys(patch.params).sort()).toEqual(
			[...TEXT_STYLE_PARAM_KEYS].sort(),
		);
		expect(patch.params.content).toBeUndefined();
	});

	it("leaves a key alone when the STYLE is the one missing it", () => {
		const partialStyle: TextStyle = {
			id: "style-partial",
			name: "Half a look",
			params: { color: "#00ff00" },
			createdAt: "2026-07-21T00:00:00.000Z",
		};
		const target = buildElement({
			params: { content: "keep me", fontSize: 33, color: "#ffffff" },
		});

		const patch = buildTextStylePatch({ element: target, style: partialStyle });

		expect(patch.params.color).toBe("#00ff00");
		expect(patch.params.fontSize).toBe(33);
		expect(patch.params.content).toBe("keep me");
	});

	it("ignores non-appearance keys smuggled into a style record", () => {
		const tamperedStyle = {
			id: "style-tampered",
			name: "Sneaky",
			params: {
				color: "#00ff00",
				content: "REPLACED",
				"transform.positionX": 9999,
			},
			createdAt: "2026-07-21T00:00:00.000Z",
		} as TextStyle;
		const target = buildElement({
			params: { content: "keep me", "transform.positionX": 10 },
		});

		const patch = buildTextStylePatch({ element: target, style: tamperedStyle });

		expect(patch.params.content).toBe("keep me");
		expect(patch.params["transform.positionX"]).toBe(10);
		expect(patch.params.color).toBe("#00ff00");
	});
});

describe("project style records", () => {
	const style: TextStyle = {
		id: "style-1",
		name: "Lower third",
		params: { color: "#ff8800", fontSize: 48 },
		createdAt: "2026-07-21T00:00:00.000Z",
	};

	it("reads an empty list from a project saved before the feature existed", () => {
		expect(readTextStyles({ project: {} })).toEqual([]);
		expect(readTextStyles({ project: null })).toEqual([]);
	});

	it("adds, finds and removes", () => {
		const withStyle = addTextStyle({ project: {}, style });
		expect(readTextStyles({ project: withStyle })).toHaveLength(1);
		expect(findTextStyle({ project: withStyle, styleId: "style-1" })?.name).toBe(
			"Lower third",
		);

		const without = removeTextStyle({
			project: withStyle,
			styleId: "style-1",
		});
		expect(readTextStyles({ project: without })).toEqual([]);
		expect(findTextStyle({ project: without, styleId: "style-1" })).toBe(
			undefined,
		);
	});

	it("replaces rather than duplicates when the same name is saved again", () => {
		const first = addTextStyle({ project: {}, style });
		const second = addTextStyle({
			project: first,
			style: { ...style, id: "style-2", name: "  lower third  " },
		});

		const saved = readTextStyles({ project: second });
		expect(saved).toHaveLength(1);
		expect(saved[0].id).toBe("style-2");
	});

	it("does not mutate the project it is handed", () => {
		const project = { textStyles: [] as TextStyle[] };
		addTextStyle({ project, style });
		expect(project.textStyles).toHaveLength(0);
	});

	it("round-trips save and delete through JSON, the way storage stores it", () => {
		const saved = addTextStyle({
			project: {},
			style: {
				...style,
				params: captureTextStyleParams({
					element: buildElement({ params: STYLED_PARAMS }),
				}),
			},
		});

		const reloaded = normalizeTextStyles({
			raw: JSON.parse(JSON.stringify(saved.textStyles)),
		});

		expect(reloaded).toHaveLength(1);
		expect(reloaded[0].name).toBe("Lower third");
		expect(reloaded[0].params.color).toBe("#ff8800");
		expect(reloaded[0].params["background.enabled"]).toBe(true);
		expect(Object.keys(reloaded[0].params).sort()).toEqual(
			[...TEXT_STYLE_PARAM_KEYS].sort(),
		);

		const afterDelete = normalizeTextStyles({
			raw: JSON.parse(
				JSON.stringify(
					removeTextStyle({ project: saved, styleId: "style-1" }).textStyles,
				),
			),
		});
		expect(afterDelete).toEqual([]);
	});
});

describe("normalizeTextStyles", () => {
	it("returns an empty list for anything that is not an array", () => {
		expect(normalizeTextStyles({ raw: undefined })).toEqual([]);
		expect(normalizeTextStyles({ raw: null })).toEqual([]);
		expect(normalizeTextStyles({ raw: "styles" })).toEqual([]);
		expect(normalizeTextStyles({ raw: { id: "x" } })).toEqual([]);
	});

	it("drops records with no usable id or name", () => {
		expect(
			normalizeTextStyles({
				raw: [
					null,
					42,
					{ name: "no id" },
					{ id: "no-name" },
					{ id: "", name: "empty id" },
				],
			}),
		).toEqual([]);
	});

	it("strips non-appearance and non-primitive param values", () => {
		const [normalized] = normalizeTextStyles({
			raw: [
				{
					id: "style-1",
					name: "Lower third",
					params: {
						color: "#ff8800",
						content: "should be dropped",
						"transform.positionX": 400,
						fontSize: { nested: true },
					},
					createdAt: "2026-07-21T00:00:00.000Z",
				},
			],
		});

		expect(normalized.params).toEqual({ color: "#ff8800" });
	});

	it("supplies a createdAt when the stored record has none", () => {
		const [normalized] = normalizeTextStyles({
			raw: [{ id: "style-1", name: "Lower third" }],
		});

		expect(normalized.params).toEqual({});
		expect(typeof normalized.createdAt).toBe("string");
	});
});
