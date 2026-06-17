/**
 * Apply an accepted Director plan to the timeline (U3).
 *
 * v0 applies the REMOVAL ops (`cut` / `take_select`) as a single all-track
 * `RemoveRangesCommand` — one undoable step, so a single Ctrl+Z restores the
 * pre-Director timeline. `reorder` ops are PROPOSED by the planner and shown in
 * the Review modal, but their application is deferred this round (returned as
 * `unappliedReorders`): building the `MoveElementCommand` move + ordering it
 * against the cuts needs live exercise (the plan's reorder-granularity open
 * question). `keep` ops are informational no-ops.
 */

import {
	RemoveRangesCommand,
	type TimeRange,
} from "@/commands/timeline/track/remove-ranges";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditorCore } from "@/core";
import type { DirectorOp } from "@framecut/hf-bridge";

export interface ApplyDirectorPlanResult {
	/** Removal ranges applied (cut + take_select). */
	cuts: number;
	/** Total seconds removed. */
	removedSec: number;
	/** Accepted reorder ops not applied in v0 (proposed only). */
	unappliedReorders: number;
}

/**
 * Pure: split accepted ops into removal tick-ranges (cut/take_select) + the
 * reorder count. `keep` is ignored. `ticksPerSecond` is injected so this is
 * unit-testable without the opencut-wasm binary.
 */
export function planRemovalRanges({
	ops,
	ticksPerSecond,
}: {
	ops: readonly DirectorOp[];
	ticksPerSecond: number;
}): { ranges: TimeRange[]; removedSec: number; reorders: number } {
	const removals = ops.filter((o) => o.op === "cut" || o.op === "take_select");
	const reorders = ops.filter((o) => o.op === "reorder").length;
	const ranges: TimeRange[] = removals.map((o) => ({
		start: Math.round(o.startSec * ticksPerSecond),
		end: Math.round(o.endSec * ticksPerSecond),
	}));
	const removedSec = removals.reduce((acc, o) => acc + (o.endSec - o.startSec), 0);
	return { ranges, removedSec, reorders };
}

/**
 * Apply the accepted ops as one undoable step. Removals go through a single
 * all-track `RemoveRangesCommand`; reorders are counted but not applied (v0).
 */
export function applyDirectorPlan({
	editor,
	ops,
}: {
	editor: EditorCore;
	ops: readonly DirectorOp[];
}): ApplyDirectorPlanResult {
	const { ranges, removedSec, reorders } = planRemovalRanges({
		ops,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	if (ranges.length === 0) {
		return { cuts: 0, removedSec: 0, unappliedReorders: reorders };
	}
	const command = new RemoveRangesCommand({ ranges });
	editor.command.execute({ command });
	return { cuts: command.getRemovedCount(), removedSec, unappliedReorders: reorders };
}
