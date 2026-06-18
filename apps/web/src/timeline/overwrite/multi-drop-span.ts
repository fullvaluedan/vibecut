/**
 * Pure, wasm-free combined-span builder for a MULTI-clip overwrite/insert drop
 * (timeline-time only, ticks).
 *
 * U5 extends the Premiere overwrite/insert edit model from a SINGLE bin clip to a
 * MULTI-selection. Dropping N selected clips onto an OCCUPIED region of a track
 * places them BACK-TO-BACK starting at the drop position, so their COMBINED span is
 * `[start, start + sum(durations))`. We carve that ONE combined span (via the shipped,
 * exhaustively-tested `planClipDrop`), then drop the N clips into the carved hole at
 * their cumulative offsets — one atomic edit, one undo (OQ2 default: combined-span).
 *
 * This module does ONLY the multi-clip-specific geometry the single-clip path didn't
 * need: the combined-span end and each clip's back-to-back start offset. The carve
 * itself stays in `planClipDrop`; no carve geometry is forked here.
 *
 * Deliberately wasm-free (plain tick numbers), mirroring `overwrite-plan.ts` and
 * `move-overwrite-plan.ts`, so it is unit-testable under bun without the opencut-wasm
 * binary. It touches no command, no EditorCore, and no element IDs.
 */

/** One incoming clip reduced to what the combined-span builder needs. */
export interface MultiDropClip {
	/** Timeline-time duration in ticks (a real clip's duration is > 0). */
	duration: number;
}

/** The combined drop span plus each clip's back-to-back start offset. */
export interface MultiDropSpan {
	/** Combined-span start A (ticks) — the drop position. */
	start: number;
	/**
	 * Combined-span end (ticks) == `start + sum(durations)`. Equals `start` for an
	 * empty clip list (a degenerate, zero-length span the caller should not carve).
	 */
	end: number;
	/**
	 * One absolute timeline-time start per clip, in the same order as `clips`, laid
	 * out back-to-back from `start`: `offsets[i] = start + sum(durations[0..i))`.
	 * Always the same length as the input `clips`.
	 */
	offsets: number[];
}

/**
 * Build the combined back-to-back span for a multi-clip drop.
 *
 * @param clips Incoming clips in selection/placement order. May be empty.
 * @param start Timeline-time start A of the first clip (ticks) — the drop position.
 * @returns The combined `[start, end)` span and each clip's absolute start offset.
 *          Never throws; an empty list yields `end === start` and `offsets === []`.
 */
export function buildMultiDropSpan({
	clips,
	start,
}: {
	clips: readonly MultiDropClip[];
	start: number;
}): MultiDropSpan {
	const offsets: number[] = [];
	let cursor = start;
	for (const clip of clips) {
		offsets.push(cursor);
		cursor += clip.duration;
	}
	return { start, end: cursor, offsets };
}
