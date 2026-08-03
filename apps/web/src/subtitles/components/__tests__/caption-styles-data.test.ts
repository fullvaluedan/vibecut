import { describe, it, expect } from "vitest";
import { CAPTION_STYLES } from "../caption-styles-data";

/**
 * Caption styles data validation: ensures 12 looks with no bleed,
 * all params are registered text params, and backgrounds are fully specified.
 * Imports the real look data from caption-styles-data.ts (an inline copy
 * here would drift from what the component actually applies).
 */

const VALID_PARAM_KEYS = [
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
	"strokeColor",
	"strokeWidth",
	"shadowColor",
	"shadowBlur",
	"shadowOffsetX",
	"shadowOffsetY",
] as const;

describe("caption-styles-data", () => {
	const NEW_LOOK_IDS = [
		"outline-pop",
		"drop-shadow",
		"broadcast",
		"minimal-mono",
		"highlighter-variant",
		"cinema-bar",
	];

	it("should have exactly 12 looks (6 original + 6 new)", () => {
		expect(CAPTION_STYLES).toHaveLength(12);
	});

	it("should have an even count (grid is 2 columns)", () => {
		expect(CAPTION_STYLES.length % 2).toBe(0);
	});

	it("should have unique ids", () => {
		const ids = CAPTION_STYLES.map((look) => look.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("should include all 6 new looks", () => {
		const lookIds = new Set(CAPTION_STYLES.map((look) => look.id));
		NEW_LOOK_IDS.forEach((id) => {
			expect(lookIds.has(id)).toBe(true, `Missing new look: ${id}`);
		});
	});

	it("should have all params keys in the valid list", () => {
		const validKeySet = new Set(VALID_PARAM_KEYS);

		CAPTION_STYLES.forEach((look) => {
			Object.keys(look.params).forEach((key) => {
				expect(validKeySet.has(key as any)).toBe(
					true,
					`Invalid param key "${key}" in look "${look.id}"`,
				);
			});
		});
	});

	it("should set background.color when background.enabled is true", () => {
		CAPTION_STYLES.forEach((look) => {
			if (look.params["background.enabled"] === true) {
				expect(look.params["background.color"]).toBeDefined(
					`Look "${look.id}" has background.enabled true but no background.color`,
				);
				expect(typeof look.params["background.color"]).toBe("string");
			}
		});
	});

	it("should have background.enabled explicitly set for all looks", () => {
		CAPTION_STYLES.forEach((look) => {
			expect(look.params["background.enabled"]).toBeDefined(
				`Look "${look.id}" missing background.enabled`,
			);
		});
	});

	it("new looks should set color, fontWeight, fontStyle explicitly", () => {
		const newLooks = CAPTION_STYLES.filter((look) =>
			NEW_LOOK_IDS.includes(look.id),
		);

		newLooks.forEach((look) => {
			expect(look.params.color).toBeDefined(
				`New look "${look.id}" missing color`,
			);
			expect(look.params.fontWeight).toBeDefined(
				`New look "${look.id}" missing fontWeight`,
			);
			expect(look.params.fontStyle).toBeDefined(
				`New look "${look.id}" missing fontStyle`,
			);
		});
	});

	it("new looks should set stroke and shadow params (0 when unused)", () => {
		const newLooks = CAPTION_STYLES.filter((look) =>
			NEW_LOOK_IDS.includes(look.id),
		);

		newLooks.forEach((look) => {
			expect(look.params.strokeColor).toBeDefined(
				`New look "${look.id}" missing strokeColor`,
			);
			expect(look.params.strokeWidth).toBeDefined(
				`New look "${look.id}" missing strokeWidth`,
			);
			expect(look.params.shadowColor).toBeDefined(
				`New look "${look.id}" missing shadowColor`,
			);
			expect(look.params.shadowBlur).toBeDefined(
				`New look "${look.id}" missing shadowBlur`,
			);
			expect(look.params.shadowOffsetX).toBeDefined(
				`New look "${look.id}" missing shadowOffsetX`,
			);
			expect(look.params.shadowOffsetY).toBeDefined(
				`New look "${look.id}" missing shadowOffsetY`,
			);
		});
	});

	it("new looks with background.enabled true should have all background properties", () => {
		const newLooks = CAPTION_STYLES.filter((look) =>
			NEW_LOOK_IDS.includes(look.id),
		);

		newLooks.forEach((look) => {
			if (look.params["background.enabled"] === true) {
				expect(look.params["background.cornerRadius"]).toBeDefined(
					`New look "${look.id}" has background.enabled true but no cornerRadius`,
				);
				expect(look.params["background.color"]).toBeDefined(
					`New look "${look.id}" has background.enabled true but no color`,
				);
				expect(look.params["background.paddingX"]).toBeDefined(
					`New look "${look.id}" missing paddingX`,
				);
				expect(look.params["background.paddingY"]).toBeDefined(
					`New look "${look.id}" missing paddingY`,
				);
				expect(look.params["background.offsetX"]).toBeDefined(
					`New look "${look.id}" missing offsetX`,
				);
				expect(look.params["background.offsetY"]).toBeDefined(
					`New look "${look.id}" missing offsetY`,
				);
			}
		});
	});
});
