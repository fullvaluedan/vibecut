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

describe("directorRetake + directorStructural deletion (Addendum 9 consolidation verdict)", () => {
	test("both fields and their setters are gone from the live store", () => {
		const state = useAiSettingsStore.getState() as unknown as Record<
			string,
			unknown
		>;
		expect(state.directorRetake).toBeUndefined();
		expect(state.setDirectorRetake).toBeUndefined();
		expect(state.directorStructural).toBeUndefined();
		expect(state.setDirectorStructural).toBeUndefined();
	});

	test("a pre-deletion persisted blob (v3, both fields true) migrates cleanly and drops both keys", () => {
		const migrated = migrateAiSettings(
			{ directorRetake: true, directorStructural: true },
			3,
		);
		expect("directorRetake" in migrated).toBe(false);
		expect("directorStructural" in migrated).toBe(false);
	});

	test("a pre-deletion persisted blob (v3, both fields false) also migrates cleanly", () => {
		const migrated = migrateAiSettings(
			{ directorRetake: false, directorStructural: false },
			3,
		);
		expect("directorRetake" in migrated).toBe(false);
		expect("directorStructural" in migrated).toBe(false);
	});

	test("a pre-v3 blob (v0) still gets the earlier fixes alongside the v4 drop", () => {
		const migrated = migrateAiSettings(
			{
				hfEngine: "native",
				directorVadDeadAirEnabled: false,
				directorRetake: true,
				directorStructural: false,
			},
			0,
		);
		expect(migrated.hfEngine).toBe("authored");
		expect("directorVadDeadAirEnabled" in migrated).toBe(false);
		expect("directorRetake" in migrated).toBe(false);
		expect("directorStructural" in migrated).toBe(false);
	});

	test("a blob with no directorRetake/directorStructural keys at all migrates without error", () => {
		const migrated = migrateAiSettings({}, 3);
		expect("directorRetake" in migrated).toBe(false);
		expect("directorStructural" in migrated).toBe(false);
	});
});
