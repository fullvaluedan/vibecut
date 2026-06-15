import { beforeEach, describe, expect, test } from "bun:test";

// Bun ships a `localStorage` that throws "currently unavailable" unless
// configured, and it's a special global the store module resolves natively (a
// globalThis shim doesn't intercept it). zustand's persist layer then logs a
// benign "Unable to update item" line on every write. These tests assert
// in-memory store behavior only — nothing reads from storage — so silence just
// that known line and let every other log through.
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

const { usePreferenceStore } = await import("../preference-store");

beforeEach(() => {
	usePreferenceStore.getState().clearLearning();
	usePreferenceStore.getState().setSelfLearningEnabled(true);
});

describe("preference-store — authored graphics taste", () => {
	test("authored deletions aggregate into graphicsStats, not templateStats", () => {
		const s = usePreferenceStore.getState();
		s.noteTemplatesDeleted([
			"authored:comp-1",
			"authored:comp-2",
			"kinetic-type",
		]);
		const { graphicsStats, templateStats } = usePreferenceStore.getState();
		expect(graphicsStats.deleted).toBe(2);
		// The unique authored ids must NOT pollute per-id template stats.
		expect(templateStats["authored:comp-1"]).toBeUndefined();
		expect(templateStats["kinetic-type"]?.deleted).toBe(1);
	});

	test("emits a learned note once enough authored graphics are deleted", () => {
		const s = usePreferenceStore.getState();
		s.noteGraphicsPlaced();
		s.noteGraphicsPlaced();
		s.noteGraphicsPlaced();
		s.noteTemplatesDeleted(["authored:a", "authored:b"]); // 2 of 3 removed
		const notes = usePreferenceStore.getState().buildPreferenceNotes("graphics");
		expect(notes.some((n) => n.includes("authored graphics"))).toBe(true);
	});

	test("no note below the keep/delete threshold", () => {
		const s = usePreferenceStore.getState();
		s.noteGraphicsPlaced();
		s.noteGraphicsPlaced();
		s.noteGraphicsPlaced();
		s.noteTemplatesDeleted(["authored:a"]); // only 1 of 3 → under 50%
		const notes = usePreferenceStore.getState().buildPreferenceNotes("graphics");
		expect(notes.some((n) => n.includes("authored graphics"))).toBe(false);
	});

	test("clearLearning resets the graphics bucket", () => {
		const s = usePreferenceStore.getState();
		s.noteGraphicsPlaced();
		s.noteTemplatesDeleted(["authored:a"]);
		s.clearLearning();
		expect(usePreferenceStore.getState().graphicsStats).toEqual({
			placed: 0,
			deleted: 0,
		});
	});
});

describe("preference-store — scope routing", () => {
	function seedCutPreference(): void {
		const s = usePreferenceStore.getState();
		// Two runs, both undone right away → "cut more conservatively" note.
		s.noteCutRun("aggressive");
		s.noteUndo();
		usePreferenceStore.getState().noteCutRun("aggressive");
		usePreferenceStore.getState().noteUndo();
	}

	function seedGraphicsPreference(): void {
		const s = usePreferenceStore.getState();
		s.noteGraphicsPlaced();
		s.noteGraphicsPlaced();
		s.noteTemplatesDeleted(["authored:a", "authored:b"]);
	}

	test('"graphics" scope excludes AI-Cut notes', () => {
		seedCutPreference();
		seedGraphicsPreference();
		const notes = usePreferenceStore.getState().buildPreferenceNotes("graphics");
		expect(notes.some((n) => n.includes("authored graphics"))).toBe(true);
		expect(notes.some((n) => n.toLowerCase().includes("passes"))).toBe(false);
	});

	test('"cut" scope excludes graphics notes', () => {
		seedCutPreference();
		seedGraphicsPreference();
		const notes = usePreferenceStore.getState().buildPreferenceNotes("cut");
		expect(notes.some((n) => n.includes("conservatively"))).toBe(true);
		expect(notes.some((n) => n.includes("authored graphics"))).toBe(false);
	});

	test('"all" scope (default) includes both', () => {
		seedCutPreference();
		seedGraphicsPreference();
		const notes = usePreferenceStore.getState().buildPreferenceNotes();
		expect(notes.some((n) => n.includes("authored graphics"))).toBe(true);
		expect(notes.some((n) => n.includes("conservatively"))).toBe(true);
	});

	test("returns nothing when self-learning is disabled", () => {
		seedGraphicsPreference();
		usePreferenceStore.getState().setSelfLearningEnabled(false);
		expect(usePreferenceStore.getState().buildPreferenceNotes()).toEqual([]);
	});
});
