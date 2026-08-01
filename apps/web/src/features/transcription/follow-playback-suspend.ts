/**
 * T16.3: auto-scroll-follow (the active word stays in view during playback)
 * suspends itself, CapCut-style, whenever the user is actively interacting
 * with the transcript panel - so it never fights a manual scroll or a hover
 * read. Two independent reasons suspend it: the pointer is currently over the
 * transcript, or a manual scroll happened within the last `suspendMs`
 * (default 2s). Pure so the timing logic is testable without mounting the
 * scrollable DOM it drives (transcript-text.tsx).
 */
export function isFollowSuspended({
	pointerOver,
	lastManualScrollAt,
	now,
	suspendMs = 2000,
}: {
	pointerOver: boolean;
	lastManualScrollAt: number | null;
	now: number;
	suspendMs?: number;
}): boolean {
	if (pointerOver) return true;
	if (lastManualScrollAt == null) return false;
	return now - lastManualScrollAt < suspendMs;
}
