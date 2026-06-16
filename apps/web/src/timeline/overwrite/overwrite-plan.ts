/**
 * Pure, wasm-free Premiere-style clip-drop planner (timeline-time only, ticks).
 *
 * The product's timeline uses a Premiere-style edit model: dropping a clip onto
 * a region already occupied on the SAME track OVERWRITES the covered frames by
 * default, and INSERTS (rippling everything from the drop point right) when Ctrl
 * is held.
 *
 * Given a track's existing clips and an incoming drop `[incomingStart, incomingEnd)`
 * with a `mode`, this returns a PLAN of timeline-time operations. A separate
 * integration layer composes commands (SplitElements / DeleteElements / Insert /
 * ripple-shift) from the plan; the planner itself touches no commands and no IDs.
 *
 * Deliberately wasm-free, mirroring `@/timeline/razor` and
 * `@/timeline/group-resize/rate-stretch`: it operates on plain tick numbers
 * (`120000` ticks/second) rather than importing `@/wasm` MediaTime helpers, so
 * it can be unit-tested under bun without pulling in the opencut-wasm binary.
 *
 * Purity boundary — the planner does ONLY timeline-time geometry:
 *   - NO source-window math (trimStart/trimEnd/sourceDuration); SplitElementsCommand
 *     preserves source windows when the integration splits at a time.
 *   - NO animation splitting, NO retime-rate adjustment, NO link/selection logic.
 *   - NO element IDs — the integration resolves which fragments to delete/ripple
 *     from the returned timeline-time ranges.
 *
 * Precondition: `existingClips` are non-overlapping (the timeline invariant). A
 * degenerate/reversed drop span (`incomingStart >= incomingEnd`) yields a no-op
 * plan rather than an invalid one — the planner never throws.
 */

export interface ClipSpan {
	/** Timeline-time start in ticks (inclusive). */
	startTime: number;
	/** Timeline-time duration in ticks (a real clip's duration is > 0). */
	duration: number;
}

/** Edit mode: overwrite (default) replaces covered frames; insert ripples right. */
export type DropMode = "overwrite" | "insert";

/**
 * One frame at 30fps (120000 ticks/second / 30 == 4000 ticks).
 *
 * Exposed for the integration layer's optional post-split sliver cleanup: a
 * fragment shorter than this is a sub-frame sliver. The PLANNER does NOT enforce
 * this — it is pure geometry; sliver filtering is a downstream concern.
 */
export const MIN_FRAME_TICKS = 4000;

/**
 * PLAN of timeline-time operations for a clip drop.
 *
 * The integration layer applies these in sequence (batched for atomic undo):
 *   1. SplitElementsCommand for each `splitTimes` entry (in order), passing all
 *      clips on the track. SplitElementsCommand ignores split times outside a
 *      clip's span, so the list never needs pre-filtering against clip bounds.
 *   2. OVERWRITE (`deleteRange != null`): DeleteElementsCommand with every clip
 *      whose fragment falls entirely within `[deleteRange.start, deleteRange.end)`.
 *   3. INSERT (`rippleShift != null`): shift every clip with
 *      `startTime >= rippleShift.fromTime` RIGHT by `rippleShift.deltaTicks`.
 *      (A true insert deletes nothing — it opens the gap by rippling.)
 *   4. InsertElementCommand to place the incoming clip at `[incomingStart, incomingEnd)`.
 */
export interface DropPlan {
	/**
	 * Timeline-time split boundaries, sorted ascending, de-duplicated. May be empty.
	 * OVERWRITE splits at both A and B (where clips straddle them) so the drop zone
	 * can be carved out cleanly. INSERT splits ONLY at A: everything from A rightward
	 * (including the right fragment of a clip straddling A) ripples as-is, so there
	 * is no B boundary to cut.
	 */
	splitTimes: number[];

	/**
	 * OVERWRITE: the `[start, end)` drop zone whose fully-contained fragments are
	 * deleted (leaving a hole for the incoming clip). `null` for INSERT, which
	 * deletes nothing.
	 */
	deleteRange: { start: number; end: number } | null;

	/**
	 * INSERT: shift every clip with `startTime >= fromTime` right by `deltaTicks`
	 * (a positive number == the incoming span length), opening the gap the incoming
	 * clip lands in. `null` for OVERWRITE (no ripple).
	 *
	 * `fromTime` is the drop start A — after the split-at-A, the right fragment of a
	 * straddling clip begins exactly at A and is included by the `>=` test.
	 */
	rippleShift: { fromTime: number; deltaTicks: number } | null;
}

const NO_OP_PLAN: DropPlan = {
	splitTimes: [],
	deleteRange: null,
	rippleShift: null,
};

/**
 * Pure planner: given existing clips and an incoming clip's span + mode, return
 * a PLAN of timeline-time operations.
 *
 * Geometry — a clip OVERLAPS `[A, B)` iff `clip.startTime < B && clip.end > A`.
 * A clip STRADDLES a boundary `T` iff `clip.startTime < T < clip.end`.
 *
 * @param existingClips Non-overlapping clips on the target track. May be empty.
 * @param incomingStart Drop-span start A (ticks).
 * @param incomingEnd   Drop-span end B (ticks); a real drop has B > A.
 * @param mode          "overwrite" (default) carves a hole, no ripple;
 *                      "insert" ripples everything from A right by (B - A).
 * @returns A valid DropPlan. Never throws — a degenerate span (A >= B) returns
 *          a no-op plan so the integration never builds an invalid clip.
 */
export function planClipDrop({
	existingClips,
	incomingStart,
	incomingEnd,
	mode = "overwrite",
}: {
	existingClips: ClipSpan[];
	incomingStart: number;
	incomingEnd: number;
	mode?: DropMode;
}): DropPlan {
	// Degenerate / reversed span: a zero- or negative-length drop is not a real
	// edit. Emit a no-op so the integration never produces a backwards delete
	// range or a negative-duration clip. (The drop handler should reject these
	// upstream too; this is defence-in-depth.)
	if (!(incomingStart < incomingEnd)) {
		return NO_OP_PLAN;
	}

	// A clip overlaps [A, B) iff start < B AND end > A. Only overlapping clips can
	// straddle a boundary, so we only inspect those for split points.
	const overlappingClips = existingClips.filter(
		(clip) =>
			clip.startTime < incomingEnd &&
			clip.startTime + clip.duration > incomingStart,
	);

	const splitTimes = new Set<number>();
	for (const clip of overlappingClips) {
		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;

		// Straddles A (start < A < end): split at A in BOTH modes. Overwrite uses
		// it to separate the surviving left fragment from the carved zone; insert
		// uses it so only the right fragment [A, end) ripples, not the whole clip.
		if (clipStart < incomingStart && incomingStart < clipEnd) {
			splitTimes.add(incomingStart);
		}

		// Straddles B (start < B < end): split at B in OVERWRITE only — it bounds
		// the carved zone on the right. INSERT never cuts at B: everything from A
		// rightward ripples by the full incoming span, so a clip crossing B simply
		// moves right as a unit (its part inside [A, B) is pushed downstream, not
		// deleted).
		if (
			mode === "overwrite" &&
			clipStart < incomingEnd &&
			incomingEnd < clipEnd
		) {
			splitTimes.add(incomingEnd);
		}
	}

	return {
		splitTimes: Array.from(splitTimes).sort((a, b) => a - b),
		deleteRange:
			mode === "overwrite"
				? { start: incomingStart, end: incomingEnd }
				: null,
		rippleShift:
			mode === "insert"
				? { fromTime: incomingStart, deltaTicks: incomingEnd - incomingStart }
				: null,
	};
}
