import { describe, expect, test } from "bun:test";
import { shouldSuppressBlurCommitOnEscape } from "@/components/ui/number-field";

/**
 * C3 fix: Escape used to set the blur-suppression flag unconditionally, so a
 * consumer with NO `onCancel` (e.g. Settings' nudge-frames field:
 * `onBlur={commit}`, no `onCancel`, `key={value}` so it never remounts) had
 * its blur-commit suppressed too - the field then displayed an uncommitted
 * draft forever. `shouldSuppressBlurCommitOnEscape` is the pure decision the
 * Escape handler now gates on: only suppress when there is a real onCancel
 * revert path; otherwise fall back to the legacy commit-on-blur behavior.
 */
describe("shouldSuppressBlurCommitOnEscape", () => {
	test("Escape with onCancel: suppresses the blur commit (reverts instead)", () => {
		expect(shouldSuppressBlurCommitOnEscape({ hasOnCancel: true })).toBe(true);
	});

	test("Escape without onCancel: does NOT suppress the blur commit (legacy commit-on-blur)", () => {
		expect(shouldSuppressBlurCommitOnEscape({ hasOnCancel: false })).toBe(false);
	});
});
