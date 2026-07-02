/** An "Add some footage..." throw means the timeline has no audio, not a failure. */
export function isNoAudioError(message: string): boolean {
	return /footage|no speech|no audio/i.test(message);
}

export type TranscriptLoadErrorKind = "ignore" | "empty" | "error";

/**
 * Decide how the Transcript panel should react to a failed/cancelled load.
 *
 * A cancel is only safe to swallow when WE initiated it (our own unmount or a
 * newer load superseding this one, i.e. `ownAbort`). A cancel we did NOT initiate
 * (a shared run we joined that someone else aborted) must surface as an actionable
 * error, never leave the panel stuck on the spinner. Pure so this decision is
 * unit-testable.
 */
export function classifyTranscriptLoadError({
	message,
	ownAbort,
}: {
	message: string;
	ownAbort: boolean;
}): TranscriptLoadErrorKind {
	if (ownAbort) return "ignore";
	if (isNoAudioError(message)) return "empty";
	return "error";
}
