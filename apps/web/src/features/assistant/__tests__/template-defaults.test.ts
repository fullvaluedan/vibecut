import { describe, expect, test } from "bun:test";
import { deriveAccent, pickForeground } from "../color-utils";
import { applyTemplateDefaults } from "../template-defaults";

const DARK_BG = "#000000";
const LIGHT_BG = "#ffffff";

describe("applyTemplateDefaults: gaps only, LLM always wins", () => {
	test("fills the position preset for callout-pill's role (upper-right corner)", () => {
		const filled = applyTemplateDefaults({
			templateId: "callout-pill",
			variables: { text: "Live" },
			backgroundColor: DARK_BG,
		});
		expect(filled.corner).toBe("top-right");
		expect(filled.text).toBe("Live");
	});

	test("fills lower-third's role (left, which reads as bottom-left with its fixed Y)", () => {
		const filled = applyTemplateDefaults({
			templateId: "lower-third",
			variables: { title: "Dan", subtitle: "Director" },
			backgroundColor: DARK_BG,
		});
		expect(filled.align).toBe("left");
	});

	test("an explicit LLM corner is never overwritten by the position default", () => {
		const filled = applyTemplateDefaults({
			templateId: "callout-pill",
			variables: { text: "Live", corner: "bottom-left" },
			backgroundColor: DARK_BG,
		});
		expect(filled.corner).toBe("bottom-left");
	});

	test("fills the accent field from the project background", () => {
		const filled = applyTemplateDefaults({
			templateId: "lower-third",
			variables: { title: "Dan" },
			backgroundColor: DARK_BG,
		});
		expect(filled.accent).toBe(deriveAccent(DARK_BG));
	});

	test("an explicit LLM accent is never overwritten by the palette", () => {
		const filled = applyTemplateDefaults({
			templateId: "lower-third",
			variables: { title: "Dan", accent: "#123456" },
			backgroundColor: DARK_BG,
		});
		expect(filled.accent).toBe("#123456");
	});

	test("fills a plain 'color' field with the contrast-safe foreground, per background", () => {
		const onDark = applyTemplateDefaults({
			templateId: "kinetic-title",
			variables: { text: "TITLE" },
			backgroundColor: DARK_BG,
		});
		const onLight = applyTemplateDefaults({
			templateId: "kinetic-title",
			variables: { text: "TITLE" },
			backgroundColor: LIGHT_BG,
		});
		expect(onDark.color).toBe(pickForeground(DARK_BG));
		expect(onLight.color).toBe(pickForeground(LIGHT_BG));
		expect(onDark.color).not.toBe(onLight.color);
	});

	test("fills kinetic-title's font with a role-appropriate face, not the field's generic default", () => {
		const filled = applyTemplateDefaults({
			templateId: "kinetic-title",
			variables: { text: "TITLE" },
			backgroundColor: DARK_BG,
		});
		expect(filled.font).toBe("Anton");
	});

	test("an explicit LLM font is never overwritten", () => {
		const filled = applyTemplateDefaults({
			templateId: "kinetic-title",
			variables: { text: "TITLE", font: "Georgia" },
			backgroundColor: DARK_BG,
		});
		expect(filled.font).toBe("Georgia");
	});

	test("leaves plain text fields alone: no gap-fill for content the model must supply itself", () => {
		const filled = applyTemplateDefaults({
			templateId: "callout-pill",
			variables: {},
			backgroundColor: DARK_BG,
		});
		expect(filled.text).toBeUndefined();
	});

	test("an unknown templateId passes variables through unchanged", () => {
		const variables = { text: "Hi" };
		const filled = applyTemplateDefaults({
			templateId: "not-a-template",
			variables,
			backgroundColor: DARK_BG,
		});
		expect(filled).toEqual(variables);
		expect(filled).not.toBe(variables);
	});
});

describe("every catalog template gets a filled accent or color where it declares one", () => {
	test("templates with an accent field always end up with a valid hex accent", () => {
		const withAccent = [
			"callout-pill",
			"lower-third",
			"number-pop",
			"section-break",
			"quote-card",
			"social-handle",
			"stat-bar",
			"bullet-list",
			"location-tag",
			"banner",
			"end-card",
		];
		for (const templateId of withAccent) {
			const filled = applyTemplateDefaults({
				templateId,
				variables: {},
				backgroundColor: LIGHT_BG,
			});
			expect(filled.accent).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	test("templates with a plain color field always end up with a valid hex foreground", () => {
		for (const templateId of ["kinetic-title", "title-subtitle"]) {
			const filled = applyTemplateDefaults({
				templateId,
				variables: {},
				backgroundColor: LIGHT_BG,
			});
			expect(filled.color).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});
