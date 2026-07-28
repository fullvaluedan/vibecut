/**
 * Per-pass watchdog signals for the Director's LLM fetches (round 12 U3/R4).
 * Before this, every pass fetch carried ONLY the run's cancel signal, so a hung
 * route (or a hung upstream model call) could spin the run forever with a
 * live-looking elapsed ticker. Each fetch now composes the cancel signal with a
 * generous per-pass timeout via `AbortSignal.any`, so whichever fires first
 * aborts the request:
 *
 * - A CANCEL abort keeps today's behavior (the run stops as "Cancelled").
 * - A TIMEOUT abort on a fail-open pass (redundancy/context/retake/structural/
 *   verify) rejects that one fetch; the pure pipeline's existing catch degrades
 *   and the run completes without that pass.
 * - A TIMEOUT abort on the PLAN pass fails the run with a plain-language error
 *   (the plan is mandatory), which lands in the dock's error card.
 */

/** The plan pass gets the long leash: it reads the whole signal table and writes
 * the full cut plan, the slowest single call in the run. 5 minutes. */
export const PLAN_PASS_TIMEOUT_MS = 300_000;

/** Every other pass (redundancy, context, retake, structural, verify) is a
 * smaller ask and fails open, so it gets the shorter leash. 3 minutes. */
export const AUX_PASS_TIMEOUT_MS = 180_000;

/**
 * Compose the run's cancel signal with a per-pass timeout. Without a cancel
 * signal the timeout stands alone (the eval and tests pass no cancel).
 */
export function composePassSignal({
	cancel,
	timeoutMs,
}: {
	cancel?: AbortSignal;
	timeoutMs: number;
}): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return cancel ? AbortSignal.any([cancel, timeout]) : timeout;
}

/**
 * True when an abort reason (or a fetch rejection) came from the per-pass
 * TIMEOUT rather than the user's cancel: `AbortSignal.timeout` aborts with a
 * DOMException named "TimeoutError", and `AbortSignal.any` propagates that
 * reason, while a user cancel aborts with the default "AbortError".
 */
export function isTimeoutAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "TimeoutError";
}
