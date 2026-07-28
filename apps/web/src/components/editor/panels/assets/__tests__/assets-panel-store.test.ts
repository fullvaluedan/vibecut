import { describe, expect, test } from "bun:test";
import {
	DEFAULT_TAB,
	TAB_KEYS,
	VISIBLE_TAB_KEYS,
	mergeAssetsPanelState,
	resolveActiveTab,
	tabs,
	useAssetsPanelStore,
} from "../assets-panel-store";
import { HIDDEN_ASSET_TABS } from "@/features/editing/surface-flags";

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

describe("hidden-panel default list (Dan's 2026-07-19 roadmap decision D4/D6, W2)", () => {
	test("VISIBLE_TAB_KEYS excludes every tab in the hidden list", () => {
		for (const hidden of HIDDEN_ASSET_TABS) {
			expect(VISIBLE_TAB_KEYS).not.toContain(hidden);
		}
	});

	test("VISIBLE_TAB_KEYS is exactly Media, Text, Shapes, Captions, Transcript, Settings", () => {
		expect(VISIBLE_TAB_KEYS).toEqual([
			"media",
			"text",
			"shapes",
			"captions",
			"transcript",
			"settings",
		]);
	});

	test("hidden tabs are PARKED, not deleted: still in TAB_KEYS and the tabs registry", () => {
		for (const hidden of HIDDEN_ASSET_TABS) {
			expect(TAB_KEYS).toContain(hidden);
			expect(tabs[hidden]).toBeDefined();
		}
	});
});

describe("assets panel store guard rail: a hidden active tab falls back to Media", () => {
	// `resolveActiveTab` is the single fallback rule the store uses in two
	// places: `setActiveTab` (runtime) and the persist `merge` option that runs
	// on rehydration (a reload). Testing it directly covers both call sites -
	// `bun test` has no `window`/`localStorage`, so zustand's persist middleware
	// never attaches its `.persist` helper here (storage is unavailable, see
	// the `createJSONStorage` fallback in zustand's middleware source); the
	// store still behaves identically in the browser, where storage exists.
	test("a hidden tab (the 'persisted active tab' case) resolves to Media", () => {
		for (const hidden of HIDDEN_ASSET_TABS) {
			expect(resolveActiveTab(hidden)).toBe(DEFAULT_TAB);
		}
	});

	test("a visible tab resolves to itself, unchanged", () => {
		for (const visible of VISIBLE_TAB_KEYS) {
			expect(resolveActiveTab(visible)).toBe(visible);
		}
	});

	test("a removed tab (not in TAB_KEYS or VISIBLE_TAB_KEYS) returns DEFAULT_TAB", () => {
		expect(resolveActiveTab("transitions" as Tab)).toBe(DEFAULT_TAB);
		expect(resolveActiveTab("adjustment" as Tab)).toBe(DEFAULT_TAB);
	});

	test("a garbage string (corrupted localStorage) returns DEFAULT_TAB", () => {
		expect(resolveActiveTab("some-random-tab-123" as Tab)).toBe(DEFAULT_TAB);
		expect(resolveActiveTab("" as Tab)).toBe(DEFAULT_TAB);
	});

	test("setActiveTab never lands on a hidden tab", () => {
		for (const hidden of HIDDEN_ASSET_TABS) {
			useAssetsPanelStore.getState().setActiveTab(hidden);
			expect(useAssetsPanelStore.getState().activeTab).toBe("media");
		}
	});

	test("setActiveTab still honors a visible tab", () => {
		useAssetsPanelStore.getState().setActiveTab("captions");
		expect(useAssetsPanelStore.getState().activeTab).toBe("captions");
		useAssetsPanelStore.getState().setActiveTab("media");
	});

	test("the store's persist config wires merge through resolveActiveTab (hidden persisted tab -> Media)", () => {
		// Exercises the exact `merge` function the store is configured with (not
		// a reimplementation), without needing zustand's storage-backed
		// `.persist` helper (unavailable under `bun test`, see comment above).
		const currentState = useAssetsPanelStore.getState();
		for (const hidden of HIDDEN_ASSET_TABS) {
			const merged = mergeAssetsPanelState({ activeTab: hidden }, currentState);
			expect(merged.activeTab).toBe("media");
		}
		const mergedVisible = mergeAssetsPanelState(
			{ activeTab: "transcript" },
			currentState,
		);
		expect(mergedVisible.activeTab).toBe("transcript");
		const mergedEmpty = mergeAssetsPanelState(undefined, currentState);
		expect(mergedEmpty.activeTab).toBe(currentState.activeTab);
	});
});
