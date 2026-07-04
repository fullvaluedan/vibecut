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

describe("directorVadDeadAirEnabled default (U2/KTD3)", () => {
	test("defaults ON so a default AI CUT run removes silent dead air", () => {
		expect(useAiSettingsStore.getState().directorVadDeadAirEnabled).toBe(true);
	});

	test("remains a user override: turning it off is honored", () => {
		useAiSettingsStore.getState().setDirectorVadDeadAirEnabled(false);
		expect(useAiSettingsStore.getState().directorVadDeadAirEnabled).toBe(false);
		useAiSettingsStore.getState().setDirectorVadDeadAirEnabled(true);
	});

	test("v2 migration resets a pre-v2 persisted false so the new default lands", () => {
		// Pre-v2 installs have the OLD default (false) frozen in storage, which would
		// shallow-merge over the new true forever without this migration.
		const migrated = migrateAiSettings({ directorVadDeadAirEnabled: false }, 1);
		expect(migrated.directorVadDeadAirEnabled).toBe(true);
	});

	test("a post-v2 persisted false is an explicit user choice and survives", () => {
		const migrated = migrateAiSettings({ directorVadDeadAirEnabled: false }, 2);
		expect(migrated.directorVadDeadAirEnabled).toBe(false);
	});

	test("v1 hfEngine migration still fires alongside v2", () => {
		const migrated = migrateAiSettings({ hfEngine: "native" }, 0);
		expect(migrated.hfEngine).toBe("authored");
		expect(migrated.directorVadDeadAirEnabled).toBe(true);
	});
});
