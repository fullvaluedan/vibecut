import { describe, expect, test } from "bun:test";
import { hasDirectorSession, shouldShowDirectorBadge } from "../dock-badge";

describe("hasDirectorSession", () => {
	test("false with no plan, draft, or keeps", () => {
		expect(hasDirectorSession({ plan: null, draft: null, keeps: [] })).toBe(false);
	});

	test("true with a plan", () => {
		expect(hasDirectorSession({ plan: { operations: [] }, draft: null, keeps: [] })).toBe(
			true,
		);
	});

	test("true with a draft", () => {
		expect(hasDirectorSession({ plan: null, draft: { spans: [] }, keeps: [] })).toBe(true);
	});

	test("true with keep rows", () => {
		expect(hasDirectorSession({ plan: null, draft: null, keeps: [{ id: "k" }] })).toBe(true);
	});
});

describe("shouldShowDirectorBadge (R1: badge while running, auto-focus on completion)", () => {
	test("never shows while the Director tab is already focused", () => {
		expect(
			shouldShowDirectorBadge({ dockTab: "director", busy: true, hasSession: true }),
		).toBe(false);
		expect(
			shouldShowDirectorBadge({ dockTab: "director", busy: false, hasSession: false }),
		).toBe(false);
	});

	test("shows on the properties tab while a run is busy", () => {
		expect(
			shouldShowDirectorBadge({ dockTab: "properties", busy: true, hasSession: false }),
		).toBe(true);
	});

	test("shows on the properties tab when a session is waiting (review/applied)", () => {
		expect(
			shouldShowDirectorBadge({ dockTab: "properties", busy: false, hasSession: true }),
		).toBe(true);
	});

	test("hidden on the properties tab when idle with no session", () => {
		expect(
			shouldShowDirectorBadge({ dockTab: "properties", busy: false, hasSession: false }),
		).toBe(false);
	});
});
