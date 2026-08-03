import { beforeEach, describe, expect, test } from "bun:test";

// zustand's persist middleware logs a benign "storage unavailable" line under
// Bun (its localStorage is a special global a globalThis shim can't intercept).
// These tests assert in-memory store behavior only - silence just that line.
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

const {
	useAiSettingsStore,
	migrateAiSettings,
	resolveDesignSpec,
	MAX_HF_PRESETS,
} = await import("../store");
const { designSpecFromStyle, getStyleById, VIBE_STYLES } = await import(
	"../styles"
);
const { describeDesignSpec } = await import("../profiles");

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

interface PersistedPreset {
	id: string;
	name: string;
	disabledTemplateIds: string[];
	promptHfAssets: string[];
	styleId: string;
	hfDirection: string;
	design?: ReturnType<typeof designSpecFromStyle>;
}

describe("migration v4 -> v5 (style profiles)", () => {
	test("presets gain a design spec seeded from their own styleId, every existing field preserved", () => {
		const persisted = {
			hfPresets: [
				{
					id: "p1",
					name: "Doc look",
					disabledTemplateIds: ["lower-third"],
					promptHfAssets: ["swiss-grid"],
					styleId: "gold",
					hfDirection: "slow and calm",
				},
				{
					id: "p2",
					name: "Loud",
					disabledTemplateIds: [],
					promptHfAssets: [],
					styleId: "acid",
					hfDirection: "",
				},
			],
			styleId: "ember",
			hfDirection: "live direction",
		};
		const migrated = migrateAiSettings(persisted, 4);
		const presets = migrated.hfPresets as PersistedPreset[];
		expect(presets).toHaveLength(2);

		// Lossless: every pre-v5 field survives untouched.
		expect(presets[0]).toMatchObject({
			id: "p1",
			name: "Doc look",
			styleId: "gold",
			hfDirection: "slow and calm",
		});
		expect(presets[0].disabledTemplateIds).toEqual(["lower-third"]);
		expect(presets[0].promptHfAssets).toEqual(["swiss-grid"]);

		// The seeded design matches the preset's own look, so a migrated
		// preset generates the exact same styling it always did.
		expect(presets[0].design).toEqual(designSpecFromStyle(getStyleById("gold")));
		expect(presets[0].design?.palette.accent).toBe("#EAB308");
		expect(presets[0].design?.fonts.display).toBe("Georgia");
		expect(presets[0].design?.motion).toBe("calm");
		expect(presets[1].design).toEqual(designSpecFromStyle(getStyleById("acid")));
		expect(presets[1].design?.palette.accent).toBe("#A3E635");

		// State outside hfPresets is untouched.
		expect(migrated.styleId).toBe("ember");
		expect(migrated.hfDirection).toBe("live direction");
	});

	test("a preset that already carries a design is left alone", () => {
		const design = {
			palette: { accent: "#123456", supporting: ["#654321"] },
			fonts: { display: "Anton", body: "Inter" },
			motion: "punchy" as const,
			density: "dense" as const,
		};
		const migrated = migrateAiSettings(
			{
				hfPresets: [
					{
						id: "p1",
						name: "Custom",
						disabledTemplateIds: [],
						promptHfAssets: [],
						styleId: "ember",
						hfDirection: "",
						design,
					},
				],
			},
			4,
		);
		const presets = migrated.hfPresets as PersistedPreset[];
		expect(presets[0].design).toEqual(design);
	});

	test("an unknown styleId seeds the default look's spec", () => {
		const migrated = migrateAiSettings(
			{
				hfPresets: [
					{
						id: "p1",
						name: "Old",
						disabledTemplateIds: [],
						promptHfAssets: [],
						styleId: "deleted-look",
						hfDirection: "",
					},
				],
			},
			4,
		);
		const presets = migrated.hfPresets as PersistedPreset[];
		expect(presets[0].design).toEqual(designSpecFromStyle(VIBE_STYLES[0]));
	});

	test("tolerates missing or null persisted state", () => {
		expect(migrateAiSettings({}, 4).hfPresets).toBeUndefined();
		expect(migrateAiSettings(null, 4)).toEqual({});
		expect(migrateAiSettings(undefined, 4)).toEqual({});
	});
});

describe("style profiles - save / load round trip", () => {
	test("a new preset seeds its design from the current factory look", () => {
		useAiSettingsStore.getState().setStyleId("acid");
		useAiSettingsStore.getState().saveHfPreset();
		const preset = useAiSettingsStore.getState().hfPresets[0];
		expect(preset.design).toEqual(designSpecFromStyle(getStyleById("acid")));
	});

	test("saving while a profile is active snapshots that profile's edited design", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		const edited = {
			palette: { accent: "#112233", supporting: ["#445566"] },
			fonts: { display: "Oswald", body: "Inter" },
			motion: "calm" as const,
			density: "sparse" as const,
		};
		useAiSettingsStore.getState().updateHfPresetDesign(id, edited);
		// Saving a NEW slot while the first profile is active carries its
		// design over (the profile is the live design).
		useAiSettingsStore.getState().saveHfPreset();
		const presets = useAiSettingsStore.getState().hfPresets;
		expect(presets).toHaveLength(2);
		expect(presets[1].design).toEqual(edited);
	});

	test("updateHfPresetDesign edits in place and keeps the preset active", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		const edited = {
			palette: { accent: "#FF0000", supporting: [] },
			fonts: { display: "Poppins", body: "Poppins" },
			motion: "punchy" as const,
			density: "dense" as const,
		};
		useAiSettingsStore.getState().updateHfPresetDesign(id, edited);
		const state = useAiSettingsStore.getState();
		expect(state.hfPresets[0].design).toEqual(edited);
		expect(state.activeHfPresetId).toBe(id);
		// The stored spec is a copy: mutating the input does not bleed in.
		edited.palette.accent = "#00FF00";
		expect(state.hfPresets[0].design.palette.accent).toBe("#FF0000");
	});

	test("duplicateHfPreset deep-copies into a new slot and activates the copy of an active profile", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		useAiSettingsStore.getState().duplicateHfPreset(id);
		const state = useAiSettingsStore.getState();
		expect(state.hfPresets).toHaveLength(2);
		const [source, copy] = state.hfPresets;
		expect(copy.id).not.toBe(source.id);
		expect(copy.name).toBe(`${source.name} copy`);
		expect(copy.design).toEqual(source.design);
		expect(copy.disabledTemplateIds).toEqual(source.disabledTemplateIds);
		// The source was active, so the copy is now the active profile.
		expect(state.activeHfPresetId).toBe(copy.id);
		// Deep copy: editing the copy leaves the source alone.
		useAiSettingsStore
			.getState()
			.updateHfPresetDesign(copy.id, {
				...copy.design,
				palette: { accent: "#000000", supporting: [] },
			});
		expect(
			useAiSettingsStore.getState().hfPresets[0].design.palette.accent,
		).toBe(source.design.palette.accent);
	});

	test("duplicate names stay unique and the list stays capped", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		useAiSettingsStore.getState().duplicateHfPreset(id);
		useAiSettingsStore.getState().duplicateHfPreset(id);
		const names = useAiSettingsStore.getState().hfPresets.map((p) => p.name);
		expect(names).toEqual([
			"Custom Template 1",
			"Custom Template 1 copy",
			"Custom Template 1 copy 2",
		]);
		for (let i = 0; i < MAX_HF_PRESETS + 2; i++) {
			useAiSettingsStore.getState().duplicateHfPreset(id);
		}
		expect(useAiSettingsStore.getState().hfPresets).toHaveLength(
			MAX_HF_PRESETS,
		);
	});
});

describe("resolveDesignSpec (the generation mapping)", () => {
	test("no active profile resolves the factory look, exactly as before profiles", () => {
		const resolved = resolveDesignSpec(useAiSettingsStore.getState());
		expect(resolved.custom).toBe(false);
		expect(resolved.name).toBe("Ember");
		expect(resolved.spec.palette.accent).toBe("#FF6E20");
		expect(resolved.spec.fonts.display).toBe("Arial");
		expect(resolved.spec.fonts.body).toBe("Arial");
	});

	test("an active profile's spec wins, including its custom fonts", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		useAiSettingsStore.getState().renameHfPreset(id, "My Brand");
		useAiSettingsStore.getState().updateHfPresetDesign(id, {
			palette: { accent: "#112233", supporting: ["#445566"] },
			fonts: { display: "Bebas Neue", body: "Inter" },
			motion: "punchy",
			density: "dense",
		});
		const resolved = resolveDesignSpec(useAiSettingsStore.getState());
		expect(resolved.custom).toBe(true);
		expect(resolved.name).toBe("My Brand");
		expect(resolved.spec.palette.accent).toBe("#112233");
		expect(resolved.spec.fonts.display).toBe("Bebas Neue");
		expect(resolved.spec.fonts.body).toBe("Inter");
		expect(resolved.spec.motion).toBe("punchy");
		expect(resolved.spec.density).toBe("dense");
	});

	test("deleting the active profile falls back to the factory look", () => {
		useAiSettingsStore.getState().saveHfPreset();
		const id = useAiSettingsStore.getState().hfPresets[0].id;
		useAiSettingsStore.getState().updateHfPresetDesign(id, {
			palette: { accent: "#112233", supporting: [] },
			fonts: { display: "Anton", body: "Inter" },
			motion: "calm",
			density: "sparse",
		});
		useAiSettingsStore.getState().deleteHfPreset(id);
		const resolved = resolveDesignSpec(useAiSettingsStore.getState());
		expect(resolved.custom).toBe(false);
		expect(resolved.spec.palette.accent).toBe("#FF6E20");
	});

	test("tolerates an unmigrated preset (no design) via its own look", () => {
		useAiSettingsStore.setState({
			hfPresets: [
				{
					id: "legacy",
					name: "Legacy",
					disabledTemplateIds: [],
					promptHfAssets: [],
					styleId: "mono",
					hfDirection: "",
				} as never,
			],
			activeHfPresetId: "legacy",
		});
		const resolved = resolveDesignSpec(useAiSettingsStore.getState());
		expect(resolved.custom).toBe(true);
		expect(resolved.spec).toEqual(designSpecFromStyle(getStyleById("mono")));
	});
});

describe("design spec helpers", () => {
	test("every factory look expresses a complete, valid spec", () => {
		for (const style of VIBE_STYLES) {
			const spec = designSpecFromStyle(style);
			expect(spec.palette.accent).toBe(style.accent);
			expect(spec.fonts.display).toBe(style.fontFamily);
			expect(spec.fonts.body).toBe(style.fontFamily);
			expect(["calm", "standard", "punchy"]).toContain(spec.motion);
			expect(["sparse", "balanced", "dense"]).toContain(spec.density);
		}
	});

	test("describeDesignSpec renders the planner one-liner (native-path context)", () => {
		expect(
			describeDesignSpec({
				palette: { accent: "#FF6E20", supporting: ["#111111", "#EEEEEE"] },
				fonts: { display: "Anton", body: "Inter" },
				motion: "punchy",
				density: "dense",
			}),
		).toBe(
			"accent #FF6E20, supporting #111111, #EEEEEE; display type Anton, body Inter; punchy motion; dense density",
		);
	});

	test("describeDesignSpec omits an empty supporting palette", () => {
		expect(
			describeDesignSpec({
				palette: { accent: "#FF6E20", supporting: [] },
				fonts: { display: "Arial", body: "Arial" },
				motion: "standard",
				density: "balanced",
			}),
		).toBe(
			"accent #FF6E20; display type Arial, body Arial; standard motion; balanced density",
		);
	});
});
