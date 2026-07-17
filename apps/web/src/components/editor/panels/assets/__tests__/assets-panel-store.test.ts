import { describe, expect, test } from "bun:test";
import { TAB_KEYS, tabs } from "../assets-panel-store";

describe("assets panel tab keys (menu IA: dead surfaces removed)", () => {
	test("no longer includes the stub transitions/adjustment tabs", () => {
		expect(TAB_KEYS).not.toContain("transitions");
		expect(TAB_KEYS).not.toContain("adjustment");
	});

	test("every remaining tab key has a registered tab definition", () => {
		for (const key of TAB_KEYS) {
			expect(tabs[key]).toBeDefined();
			expect(tabs[key].label.length).toBeGreaterThan(0);
		}
	});

	test("the tabs registry has no leftover entries for the removed keys", () => {
		const registry = tabs as Record<string, unknown>;
		expect(registry.transitions).toBeUndefined();
		expect(registry.adjustment).toBeUndefined();
	});

	test("the real tabs are still present", () => {
		expect(TAB_KEYS).toContain("media");
		expect(TAB_KEYS).toContain("hyperframes");
		expect(TAB_KEYS).toContain("settings");
	});
});
