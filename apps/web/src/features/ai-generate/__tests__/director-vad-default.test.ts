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

const { useAiSettingsStore } = await import("../store");

describe("directorVadDeadAirEnabled default (U2/KTD3)", () => {
	test("defaults ON so a default AI CUT run removes silent dead air", () => {
		expect(useAiSettingsStore.getState().directorVadDeadAirEnabled).toBe(true);
	});

	test("remains a user override: turning it off is honored", () => {
		useAiSettingsStore.getState().setDirectorVadDeadAirEnabled(false);
		expect(useAiSettingsStore.getState().directorVadDeadAirEnabled).toBe(false);
		useAiSettingsStore.getState().setDirectorVadDeadAirEnabled(true);
	});
});
