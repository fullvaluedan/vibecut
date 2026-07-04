/**
 * Pure media-duration guard (U8).
 *
 * `HTMLMediaElement.duration` is `NaN` before metadata loads and can resolve to
 * `Infinity` (live/streaming sources) or `0` (malformed files). Returning those
 * verbatim makes downstream `mediaTimeFromSeconds`/`toElementDurationTicks`
 * (which only guard `== null`) throw or build a zero-length element on paste.
 * Collapse every non-finite / non-positive value to `undefined` so the
 * `DEFAULT_NEW_ELEMENT_DURATION` fallback takes over.
 *
 * Kept free of the DOM `HTMLMediaElement` so it is unit-testable without a
 * browser.
 */
export function finiteDurationOrUndefined(seconds: number): number | undefined {
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
