import { describe, expect, test } from "bun:test";
import {
	markOnboardingDismissed,
	readOnboardingDismissed,
	shouldShowFirstRunBanner,
} from "../first-run-banner";

describe("shouldShowFirstRunBanner", () => {
	test("no projects, never dismissed: show it", () => {
		expect(
			shouldShowFirstRunBanner({ hasProjects: false, dismissed: false }),
		).toBe(true);
	});

	test("no projects, but dismissed: hidden", () => {
		expect(
			shouldShowFirstRunBanner({ hasProjects: false, dismissed: true }),
		).toBe(false);
	});

	test("has projects, never dismissed: hidden (first-run only)", () => {
		expect(
			shouldShowFirstRunBanner({ hasProjects: true, dismissed: false }),
		).toBe(false);
	});

	test("has projects and dismissed: hidden", () => {
		expect(
			shouldShowFirstRunBanner({ hasProjects: true, dismissed: true }),
		).toBe(false);
	});
});

describe("readOnboardingDismissed / markOnboardingDismissed", () => {
	// `bun test` has no `window`/`localStorage` (see assets-panel-store.test.ts
	// for the same note) - both helpers guard with try/catch, so this only
	// verifies they degrade to safe no-ops rather than throwing.
	test("readOnboardingDismissed never throws without storage", () => {
		expect(() => readOnboardingDismissed()).not.toThrow();
		expect(readOnboardingDismissed()).toBe(false);
	});

	test("markOnboardingDismissed never throws without storage", () => {
		expect(() => markOnboardingDismissed()).not.toThrow();
	});
});
