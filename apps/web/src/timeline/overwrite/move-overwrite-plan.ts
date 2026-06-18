/**
 * Pure, wasm-free move-overwrite gate + carve-input builder (timeline-time, ticks).
 *
 * U4 extends the Premiere overwrite/insert edit model from DROPS to MOVES: moving
 * an existing clip onto an OCCUPIED region of its target track carves it the same
 * way a bin drop does (OVERWRITE replaces the covered frames; INSERT ripples
 * everything from the drop point right). The carve geometry itself is the shipped,
 * exhaustively-tested `planClipDrop` — this module does ONLY the move-specific
 * pre-step the drop path doesn't need: EXCLUDE the moved clip from the carve.
 *
 * The single critical invariant: the clip being moved is the INCOMING element, not
 * a victim. It must never appear in `existingClips`, so it can never carve, delete,
 * or ripple itself. `buildMoveCarveInputs` filters it out by id before the planner
 * ever sees the track, and reports whether an actual overlap remains — if not, the
 * caller must fall through to the ordinary (non-carving) move resolution unchanged.
 *
 * Deliberately wasm-free (plain tick numbers), mirroring `overwrite-plan.ts`, so it
 * is unit-testable under bun without the opencut-wasm binary. It touches no command,
 * no EditorCore, and no element IDs beyond the single `movedElementId` it excludes.
 */

import type { ClipSpan } from "./overwrite-plan";

/** A target-track element, reduced to what the move-carve gate needs. */
export interface MoveCarveElement extends ClipSpan {
	/** Stable element id — used ONLY to exclude the moved clip from the carve. */
	id: string;
}

/**
 * Inputs ready to feed `planClipDrop` for a move-carve, plus the gate decision.
 *
 * `existingClips` is the target track's clips with the moved clip removed; the
 * caller passes it straight to `planClipDrop`. `overlaps` is the conservative gate:
 * the moved clip's new span actually intersects another clip on the target track.
 * When `overlaps` is false the caller MUST NOT carve — it falls through to today's
 * ordinary move resolution unchanged (strictly additive behaviour).
 */
export interface MoveCarveInputs {
	existingClips: ClipSpan[];
	incomingStart: number;
	incomingEnd: number;
	overlaps: boolean;
}

/**
 * Build the carve inputs for a single-clip move onto its target track.
 *
 * Geometry — a clip OVERLAPS the moved span `[newStart, newEnd)` iff
 * `clip.startTime < newEnd && clip.end > newStart`. Touching edges do NOT overlap
 * (half-open interval), matching `planClipDrop` and the drop-path overlap gate.
 *
 * @param targetTrackElements All elements currently on the destination track,
 *        INCLUDING the moved clip when the move stays on the same track. (When the
 *        clip moves to a different track it simply won't be present — the filter is
 *        a no-op and the overlap test still excludes it by id, so both cases are
 *        handled uniformly.)
 * @param movedElementId The id of the clip being moved — excluded from the carve.
 * @param newStart New timeline-time start of the moved clip (ticks).
 * @param newDuration Duration of the moved clip (ticks); unchanged by a move.
 * @returns Carve inputs with the moved clip excluded from `existingClips`, and the
 *          `overlaps` gate. Never throws.
 */
export function buildMoveCarveInputs({
	targetTrackElements,
	movedElementId,
	newStart,
	newDuration,
}: {
	targetTrackElements: readonly MoveCarveElement[];
	movedElementId: string;
	newStart: number;
	newDuration: number;
}): MoveCarveInputs {
	const newEnd = newStart + newDuration;

	// CRITICAL: drop the moved clip itself. It is the incoming element, never a
	// carve victim — leaving it in would let it split/delete/ripple itself.
	const existingClips = targetTrackElements
		.filter((element) => element.id !== movedElementId)
		.map(({ startTime, duration }) => ({ startTime, duration }));

	const overlaps =
		newStart < newEnd &&
		existingClips.some(
			(clip) =>
				clip.startTime < newEnd && clip.startTime + clip.duration > newStart,
		);

	return {
		existingClips,
		incomingStart: newStart,
		incomingEnd: newEnd,
		overlaps,
	};
}
