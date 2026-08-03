import { describe, it, expect } from "vitest";
import { CAPTION_STYLES, CAPTION_STYLE_RESET } from "../caption-styles-data";
import { DEFAULTS } from "@/timeline/defaults";

/**
 * Caption-style sequencing invariants. Applying a look merges its params
 * over the caption's existing params (caption-styles.tsx applyStyle:
 * `{ ...el.params, ...style.params }`), so a key a look omits would survive
 * from whatever look was applied before — the round-19 "look bleed" defect.
 * These tests pin the fix: every look sets the full union key set, so look
 * application is order-independent.
 */

const UNION_KEYS = [
	...new Set(CAPTION_STYLES.flatMap((look) => Object.keys(look.params))),
].sort();

describe("caption-styles sequencing", () => {
	it("every look defines exactly the union key set (no missing, no extras)", () => {
		expect(UNION_KEYS.length).toBeGreaterThan(0);
		CAPTION_STYLES.forEach((look) => {
			expect(Object.keys(look.params).sort()).toEqual(UNION_KEYS);
		});
	});

	it("reset values are the caption style's own defaults (fresh application unchanged)", () => {
		expect(CAPTION_STYLE_RESET).toEqual({
			color: DEFAULTS.text.element.params.color,
			fontWeight: DEFAULTS.text.element.params.fontWeight,
			fontStyle: DEFAULTS.text.element.params.fontStyle,
			letterSpacing: DEFAULTS.text.letterSpacing,
			"background.enabled": DEFAULTS.text.background.enabled,
			"background.color": DEFAULTS.text.background.color,
			"background.cornerRadius": DEFAULTS.text.background.cornerRadius,
			"background.paddingX": DEFAULTS.text.background.paddingX,
			"background.paddingY": DEFAULTS.text.background.paddingY,
			"background.offsetX": DEFAULTS.text.background.offsetX,
			"background.offsetY": DEFAULTS.text.background.offsetY,
			strokeColor: DEFAULTS.text.stroke.color,
			strokeWidth: DEFAULTS.text.stroke.width,
			shadowColor: DEFAULTS.text.shadow.color,
			shadowBlur: DEFAULTS.text.shadow.blur,
			shadowOffsetX: DEFAULTS.text.shadow.offsetX,
			shadowOffsetY: DEFAULTS.text.shadow.offsetY,
		});
	});

	it("applying look A then look B yields exactly applying look B fresh (12x12 sweep)", () => {
		// A caption carrying residue from earlier styling on every union key,
		// plus non-union params (content/fontSize/transform) that looks must
		// leave untouched.
		const captionParams: Record<string, unknown> = {
			content: "hello world",
			fontSize: 42,
			"transform.positionX": 10,
			"transform.positionY": 20,
			color: "#123456",
			fontWeight: "bold",
			fontStyle: "italic",
			letterSpacing: 9,
			"background.enabled": true,
			"background.color": "#ff00ff",
			"background.cornerRadius": 99,
			"background.paddingX": 77,
			"background.paddingY": 66,
			"background.offsetX": 5,
			"background.offsetY": -5,
			strokeColor: "#00ff00",
			strokeWidth: 7,
			shadowColor: "#0000ff",
			shadowBlur: 11,
			shadowOffsetX: 3,
			shadowOffsetY: -3,
		};
		CAPTION_STYLES.forEach((a) => {
			CAPTION_STYLES.forEach((b) => {
				const afterA = { ...captionParams, ...a.params };
				const afterAB = { ...afterA, ...b.params };
				const freshB = { ...captionParams, ...b.params };
				expect(afterAB).toEqual(freshB);
			});
		});
	});
});
