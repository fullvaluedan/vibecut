import { describe, expect, test } from "bun:test";
import { migrateAiSettings } from "../store";

// v5 -> v6 (T21.2 provider abstraction): additive only. The named-provider
// key/model fields and the per-feature provider picks are new; every pre-v6
// key (authMode, the Anthropic/custom connection fields, presets with their
// v5 design specs) must survive untouched - the persisted store's shape for
// the existing modes is byte-stable because the eval disk cache keys on it.
describe("migrateAiSettings v5 -> v6 (T21.2)", () => {
	test("a full v5 blob survives losslessly and gains the default picks", () => {
		const v5 = {
			authMode: "api-key",
			anthropicApiKey: "sk-ant-1",
			customBaseUrl: "http://localhost:11434/v1",
			customApiKey: "local-key",
			customModel: "hermes-3",
			heygenApiKey: "hg",
			serpApiKey: "sp",
			groqApiKey: "gsk",
			backgroundTranscriptionEnabled: false,
			transcriptionBackend: "cloud",
			directorVisionEnabled: true,
			lowPowerMode: true,
			hfEngine: "authored",
			backend: "local",
			styleId: "ember",
			disabledTemplateIds: ["kinetic-title"],
			promptHfAssets: ["us-map"],
			hfBrowserView: "list",
			hfDirection: "keep it minimal",
			tokensUsedTotal: 1234,
			hfPresets: [
				{
					id: "p1",
					name: "Custom Template 1",
					disabledTemplateIds: [],
					promptHfAssets: [],
					styleId: "ember",
					hfDirection: "",
					design: { palette: { accent: "#fff" } },
				},
			],
			activeHfPresetId: "p1",
		};
		const migrated = migrateAiSettings(structuredClone(v5), 5);
		// Every v5 key is preserved verbatim.
		for (const [key, value] of Object.entries(v5)) {
			expect(migrated[key]).toEqual(value);
		}
		// The new per-feature picks default to following the global connection.
		expect(migrated.directorProvider).toBe("default");
		expect(migrated.assistantProvider).toBe("default");
		expect(migrated.hyperframesProvider).toBe("default");
	});

	test("existing picks are never overwritten (migrating a partial v6 blob)", () => {
		const migrated = migrateAiSettings(
			{ authMode: "openai", assistantProvider: "groq-llm" },
			5,
		);
		expect(migrated.authMode).toBe("openai");
		expect(migrated.assistantProvider).toBe("groq-llm");
		expect(migrated.directorProvider).toBe("default");
	});

	test("the v5 preset design seeding still runs underneath v6", () => {
		const migrated = migrateAiSettings(
			{ hfPresets: [{ id: "p1", name: "Old", styleId: "ember" }] },
			4,
		);
		const presets = migrated.hfPresets as { design?: unknown }[];
		expect(presets[0].design).toBeDefined();
		expect(migrated.directorProvider).toBe("default");
	});

	test("an empty / garbage blob migrates without throwing (v5 precedent: no decoration)", () => {
		expect(migrateAiSettings(undefined, 0)).toEqual({});
		expect(migrateAiSettings(null, 4)).toEqual({});
	});
});
