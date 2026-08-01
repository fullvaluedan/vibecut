import { describe, expect, test } from "bun:test";
import { ASSISTANT_TEMPLATE_CATALOG } from "../template-catalog";

/** T17.4: every template description now carries a purpose hint (what it is
 * FOR, not just what it looks like) so the model can pick the right template
 * without any system-prompt wording changing - this is catalog DATA, read
 * straight into `prompt.ts`'s `describeTemplates()`. */
describe("catalog descriptions carry a purpose hint for every template", () => {
	test("the catalog is non-empty", () => {
		expect(ASSISTANT_TEMPLATE_CATALOG.length).toBeGreaterThan(0);
	});

	test("every template's description names what it looks like AND what it is for", () => {
		for (const template of ASSISTANT_TEMPLATE_CATALOG) {
			expect(template.description.length).toBeGreaterThan(20);
			// The look-vs-purpose split is written as "<what it looks like> - <what
			// it is for>" throughout templates.ts.
			expect(template.description).toContain(" - ");
			// No em dashes anywhere in this catalog data (code point U+2014).
			expect(template.description).not.toContain(String.fromCharCode(0x2014));
		}
	});
});
