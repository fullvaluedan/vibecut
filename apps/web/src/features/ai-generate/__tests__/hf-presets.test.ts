import { beforeEach, describe, expect, test } from "bun:test";

// zustand's persist middleware logs a benign "storage unavailable" line under
// Bun (its localStorage is a special global a globalThis shim can't intercept).
// These tests assert in-memory store behavior only — silence just that line.
const isZustandPersistNoise = (args: unknown[]): boolean =>
	typeof args[0] === "string" &&
	args[0].includes("[zustand persist middleware]");
for (const method of ["error", "warn", "log"] as const) {
	const original = console[method];
	console[method] = (...args: unknown[]) => {
		if (isZustandPersistNoise(args)) return;
		original(...args);
	};
}

const { useAiSettingsStore, MAX_HF_PRESETS } = await import("../store");

function reset(): void {
	useAiSettingsStore.setState({
		hfPresets: [],
		activeHfPresetId: null,
		disabledTemplateIds: [],
		promptHfAssets: [],
		styleId: "ember",
		hfDirection: "",
	});
}

beforeEach(reset);

describe("HyperFrames presets — save / load", () => {
	test("saving snapshots the current selections under a default name", () => {
		const s = useAiSettingsStore.getState();
		s.setStyleId("aurora");
		s.setHfDirection("punchy titles");
		s.toggleTemplate("number-pop"); // now disabled
		s.togglePromptHfAsset("swiss-grid");

		useAiSettingsStore.getState().saveHfPreset();
		const { hfPresets, activeHfPresetId } = useAiSettingsStore.getState();
		expect(hfPresets).toHaveLength(1);
		const preset = hfPresets[0];
		expect(preset.name).toBe("Custom Template 1");
		expect(preset.styleId).toBe("aurora");
		expect(preset.hfDirection).toBe("punchy titles");
		expect(preset.disabledTemplateIds).toContain("number-pop");
		expect(preset.promptHfAssets).toContain("swiss-grid");
		expect(activeHfPresetId).toBe(preset.id);
	});

	test("loading re-applies a preset's selections and marks it active", () => {
		const s = useAiSettingsStore.getState();
		s.setHfDirection("first");
		s.toggleTemplate("lower-third");
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;

		// Change everything away from the saved snapshot…
		const s2 = useAiSettingsStore.getState();
		s2.setHfDirection("changed");
		s2.toggleTemplate("lower-third"); // re-enable
		s2.setStyleId("ember");
		expect(useAiSettingsStore.getState().activeHfPresetId).toBeNull();

		// …then load it back.
		useAiSettingsStore.getState().loadHfPreset(id);
		const st = useAiSettingsStore.getState();
		expect(st.hfDirection).toBe("first");
		expect(st.disabledTemplateIds).toContain("lower-third");
		expect(st.activeHfPresetId).toBe(id);
	});

	test("a snapshot is decoupled from later live edits (deep copy)", () => {
		const s = useAiSettingsStore.getState();
		s.toggleTemplate("callout-pill");
		useAiSettingsStore.getState().saveHfPreset();
		const before = [
			...useAiSettingsStore.getState().hfPresets[0].disabledTemplateIds,
		];
		// Mutating live state must not bleed into the stored preset.
		useAiSettingsStore.getState().toggleTemplate("section-break");
		expect(useAiSettingsStore.getState().hfPresets[0].disabledTemplateIds).toEqual(
			before,
		);
	});
});

describe("HyperFrames presets — divergence highlight", () => {
	test.each([
		["toggleTemplate", () => useAiSettingsStore.getState().toggleTemplate("x")],
		["setStyleId", () => useAiSettingsStore.getState().setStyleId("aurora")],
		[
			"setHfDirection",
			() => useAiSettingsStore.getState().setHfDirection("y"),
		],
		[
			"togglePromptHfAsset",
			() => useAiSettingsStore.getState().togglePromptHfAsset("z"),
		],
		[
			"setTemplatesEnabled",
			() => useAiSettingsStore.getState().setTemplatesEnabled(["x"], true),
		],
	])("%s clears the active preset", (_label, diverge) => {
		useAiSettingsStore.getState().saveHfPreset();
		expect(useAiSettingsStore.getState().activeHfPresetId).not.toBeNull();
		diverge();
		expect(useAiSettingsStore.getState().activeHfPresetId).toBeNull();
	});
});

describe("HyperFrames presets — manage", () => {
	test("update overwrites an existing slot with the current selection", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		useAiSettingsStore.getState().setHfDirection("v2");
		useAiSettingsStore.getState().saveHfPreset(id); // overwrite
		const { hfPresets, activeHfPresetId } = useAiSettingsStore.getState();
		expect(hfPresets).toHaveLength(1);
		expect(hfPresets[0].hfDirection).toBe("v2");
		expect(activeHfPresetId).toBe(id);
	});

	test(`caps at ${MAX_HF_PRESETS} presets`, () => {
		for (let i = 0; i < MAX_HF_PRESETS + 3; i++) {
			useAiSettingsStore.getState().saveHfPreset();
		}
		expect(useAiSettingsStore.getState().hfPresets).toHaveLength(MAX_HF_PRESETS);
	});

	test("default name reuses the lowest free slot after a delete", () => {
		const s = useAiSettingsStore.getState();
		s.saveHfPreset(); // Custom Template 1
		s.saveHfPreset(); // Custom Template 2
		const firstId = useAiSettingsStore.getState().hfPresets[0].id;
		useAiSettingsStore.getState().deleteHfPreset(firstId);
		useAiSettingsStore.getState().saveHfPreset(); // should reclaim "1"
		const names = useAiSettingsStore
			.getState()
			.hfPresets.map((p) => p.name)
			.sort();
		expect(names).toEqual(["Custom Template 1", "Custom Template 2"]);
	});

	test("rename ignores a blank name", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		useAiSettingsStore.getState().renameHfPreset(id, "  ");
		expect(useAiSettingsStore.getState().hfPresets[0].name).toBe(
			"Custom Template 1",
		);
		useAiSettingsStore.getState().renameHfPreset(id, "My intro look");
		expect(useAiSettingsStore.getState().hfPresets[0].name).toBe(
			"My intro look",
		);
	});

	test("deleting the active preset clears the active id", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		expect(useAiSettingsStore.getState().activeHfPresetId).toBe(id);
		useAiSettingsStore.getState().deleteHfPreset(id);
		const st = useAiSettingsStore.getState();
		expect(st.hfPresets).toHaveLength(0);
		expect(st.activeHfPresetId).toBeNull();
	});
});
