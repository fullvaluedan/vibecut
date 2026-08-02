/**
 * T21.1: dismissible first-run banner on the home page ("New here? See how
 * VibeCut works - 2 minutes", linking to /get-started). Shown only before
 * the user's first project exists and only if they never dismissed it - no
 * auto-redirect, ever. The dismissed flag is a plain localStorage read/write
 * (same guarded try/catch pattern as changelog-notification.tsx); the
 * predicate itself is pure and unit-testable without touching storage.
 */

export const ONBOARDING_DISMISSED_KEY = "vibecut-onboarding-dismissed";

/** Pure: shown pre-first-project and only if never dismissed. */
export function shouldShowFirstRunBanner({
	hasProjects,
	dismissed,
}: {
	hasProjects: boolean;
	dismissed: boolean;
}): boolean {
	return !hasProjects && !dismissed;
}

/** Reads the dismissed flag. Unavailable/blocked storage reads as "not dismissed". */
export function readOnboardingDismissed(): boolean {
	try {
		return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

/** Persists the dismissal. A blocked storage write is a silent no-op. */
export function markOnboardingDismissed(): void {
	try {
		localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
	} catch {
		// localStorage unavailable (private browsing, disabled storage, etc).
	}
}
