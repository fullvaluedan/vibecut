/**
 * Pure transcript-scoping + authorable-content helpers for the HyperFrames run
 * engine. No editor/WASM deps — unit-testable (mirrors chunk-plan.ts). Both the
 * single-clip and whole-timeline/variant paths slice the ONE timeline transcript
 * through `scopeSegments`, and decide whether a span is worth authoring through
 * `hasAuthorableContent`, so the rule lives in one place.
 */

export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

/** Segments scoped to [startSec, endSec], offset to 0, as bracketed text. */
export function scopeSegments(
	segments: TranscriptSegment[],
	startSec: number,
	endSec: number,
): string {
	return segments
		.filter((s) => s.end > startSec && s.start < endSec)
		.map(
			(s) =>
				`[${Math.max(0, s.start - startSec).toFixed(1)}–${Math.max(
					0,
					s.end - startSec,
				).toFixed(1)}] ${s.text.trim()}`,
		)
		.join("\n");
}

/**
 * Is there anything to author from? Graphics recap SPOKEN content, so a span
 * with no transcript AND no user direction has nothing to author — every chunk
 * would spawn a `claude -p` that correctly refuses. True when either trimmed
 * string is non-empty. (A variant ANGLE alone is not content — callers pass the
 * user direction, not the angle.)
 */
export function hasAuthorableContent(
	transcript: string,
	direction: string,
): boolean {
	return transcript.trim().length > 0 || direction.trim().length > 0;
}
