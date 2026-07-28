import { describe, expect, test } from "bun:test";

// Silence the benign zustand-persist "storage unavailable" line under Bun (storage is
// absent here, so the store falls back to its initial values, which is what we assert).
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

const { useAiSettingsStore, migrateAiSettings } = await import("../store");

describe("directorVadDeadAirEnabled deletion (menu IA round, Dan's decision)", () => {
	test("the field and its setter are gone from the live store", () => {
		const state = useAiSettingsStore.getState() as unknown as Record<
			string,
			unknown
		>;
		expect(state.directorVadDeadAirEnabled).toBeUndefined();
		expect(state.setDirectorVadDeadAirEnabled).toBeUndefined();
	});

	test("a pre-deletion persisted blob (v2, field true) migrates cleanly and drops the key", () => {
		const migrated = migrateAiSettings({ directorVadDeadAirEnabled: true }, 2);
		expect("directorVadDeadAirEnabled" in migrated).toBe(false);
	});

	test("a pre-deletion persisted blob (v2, field false) also migrates cleanly", () => {
		const migrated = migrateAiSettings({ directorVadDeadAirEnabled: false }, 2);
		expect("directorVadDeadAirEnabled" in migrated).toBe(false);
	});

	test("a pre-v2 blob (v0) still gets the v1 hfEngine fix alongside the v3 drop", () => {
		const migrated = migrateAiSettings(
			{ hfEngine: "native", directorVadDeadAirEnabled: false },
			0,
		);
		expect(migrated.hfEngine).toBe("authored");
		expect("directorVadDeadAirEnabled" in migrated).toBe(false);
	});

	test("a blob with no directorVadDeadAirEnabled key at all migrates without error", () => {
		const migrated = migrateAiSettings({}, 2);
		expect("directorVadDeadAirEnabled" in migrated).toBe(false);
	});
});
