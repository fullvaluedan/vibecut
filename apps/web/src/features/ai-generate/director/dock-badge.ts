/**
 * Pure predicates for the Director dock shell's tab badge (R1). Kept out of the
 * React component so the auto-focus/badge rule is bun-testable without mounting
 * anything.
 */

/** A Director session exists when there is a plan, a draft, or any keep rows:
 * something the user hasn't dismissed yet, regardless of run/applied phase. */
export function hasDirectorSession({
	plan,
	draft,
	keeps,
}: {
	plan: unknown;
	draft: unknown;
	keeps: readonly unknown[];
}): boolean {
	return plan !== null || draft !== null || keeps.length > 0;
}

/**
 * The Director tab's activity dot shows only when the user is NOT already looking
 * at it, AND either a run is in flight (badge while RUNNING, per Dan's fork
 * decision: auto-focus happens on completion, not mid-run, so a user who
 * switched away needs the nudge) or a session is waiting to be reviewed/dismissed.
 */
export function shouldShowDirectorBadge({
	dockTab,
	busy,
	hasSession,
}: {
	dockTab: "properties" | "director";
	busy: boolean;
	hasSession: boolean;
}): boolean {
	if (dockTab === "director") return false;
	return busy || hasSession;
}
