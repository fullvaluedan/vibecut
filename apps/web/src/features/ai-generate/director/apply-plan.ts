/**
 * Apply an accepted Director plan to the timeline (U3 + Round-2 U1).
 *
 * Removal ops (`cut` / `take_select`) apply as one all-track `RemoveRangesCommand`,
 * and `reorder` ops apply as a `MoveElementCommand` that shifts the elements in the
 * reordered span to the target time. Both are wrapped in a single `BatchCommand`
 * (reorders FIRST — a move repositions only its own elements without rippling, so
 * the removal ranges, expressed in original coordinates, still line up). One
 * undoable step: a single Ctrl+Z restores the pre-Director timeline. `keep` ops are
 * informational no-ops.
 */

import {
	RemoveRangesCommand,
	type TimeRange,
} from "@/commands/timeline/track/remove-ranges";
import { MoveElementCommand } from "@/commands/timeline/element/move-elements";
import { ConsolidateAdjacentClipsCommand } from "@/commands/timeline/track/consolidate-adjacent-clips";
import { BatchCommand } from "@/commands/batch-command";
import type { Command } from "@/commands/base-command";
import type { PlannedElementMove } from "@/timeline/group-move/types";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { WordTiming } from "./cut-utils";
import {
	coalesceRemovalRanges,
	subtractRemovalRanges,
	type ProtectedSpanSec,
} from "./coalesce-removal-ranges";
import { MIN_SURVIVING_CLIP_FRAMES } from "./content-word";

export interface ApplyDirectorPlanResult {
	/** Removal ranges applied (cut + take_select). */
	cuts: number;
	/** Total seconds removed. */
	removedSec: number;
	/** Reorder ops applied as element moves. */
	reorders: number;
	/**
	 * The executed Director command (the `BatchCommand`, or a single command), or
	 * null when nothing was applied. The revisable-apply flow (U8) captures this
	 * handle so it can verify the batch is still the controllable top of the undo
	 * stack before it undoes/redoes it (U8 fix against manual Ctrl+Z / external edits).
	 */
	appliedCommand: Command | null;
}

/** One element to relocate, in plain ticks (wasm-free so it's unit-testable). */
export interface ReorderElement {
	elementId: string;
	trackId: string;
	startTimeTicks: number;
	durationTicks: number;
}

/** A resolved reorder move, in plain ticks. */
export interface ReorderMove {
	elementId: string;
	trackId: string;
	newStartTimeTicks: number;
}

/**
 * Pure: split accepted ops into removal tick-ranges (cut/take_select). `keep` and
 * `reorder` are ignored here. `ticksPerSecond` is injected so this is unit-testable
 * without the opencut-wasm binary.
 */
export function planRemovalRanges({
	ops,
	ticksPerSecond,
}: {
	ops: readonly DirectorOp[];
	ticksPerSecond: number;
}): { ranges: TimeRange[]; removedSec: number } {
	const removals = ops.filter((o) => o.op === "cut" || o.op === "take_select");
	const ranges: TimeRange[] = removals.map((o) => ({
		start: Math.round(o.startSec * ticksPerSecond),
		end: Math.round(o.endSec * ticksPerSecond),
	}));
	const removedSec = removals.reduce(
		(acc, o) => acc + (o.endSec - o.startSec),
		0,
	);
	return { ranges, removedSec };
}

/** Complement gaps shorter than this (seconds, ~1 frame) are not worth removing. */
const SLIVER_TOLERANCE_SEC = 1 / 30;

/** A timeline span to KEEP (seconds). */
export interface InverseKeepSpan {
	startSec: number;
	endSec: number;
}

/**
 * Pure: compute the removal ranges for Highlight mode — the COMPLEMENT of the kept
 * spans over `[0, totalSec)`. Keeps are clamped to the timeline, merged, and the
 * gaps between/around them become removal ranges (sub-frame slivers dropped). An
 * EMPTY keep set throws — Highlight must never silently remove the entire timeline
 * (the safety rail behind the inverse apply). `ticksPerSecond` is injected so this
 * is unit-testable without the opencut-wasm binary.
 */
export function planKeepInverseRanges({
	keeps,
	totalSec,
	ticksPerSecond,
}: {
	keeps: readonly InverseKeepSpan[];
	totalSec: number;
	ticksPerSecond: number;
}): { ranges: TimeRange[]; removedSec: number } {
	const valid = keeps
		.map((k) => ({
			start: Math.max(0, Math.min(k.startSec, totalSec)),
			end: Math.max(0, Math.min(k.endSec, totalSec)),
		}))
		.filter((k) => k.end > k.start)
		.sort((a, b) => a.start - b.start);

	if (valid.length === 0) {
		throw new Error(
			"Highlight has nothing to keep — refusing to remove the entire timeline.",
		);
	}

	// Merge overlapping/adjacent keeps.
	const merged: { start: number; end: number }[] = [];
	for (const k of valid) {
		const last = merged[merged.length - 1];
		if (last && k.start <= last.end) last.end = Math.max(last.end, k.end);
		else merged.push({ start: k.start, end: k.end });
	}

	// The complement: [0, firstKeepStart), each inter-keep gap, [lastKeepEnd, totalSec).
	const ranges: TimeRange[] = [];
	let removedSec = 0;
	let cursor = 0;
	const pushGap = ({ start, end }: { start: number; end: number }) => {
		if (end - start < SLIVER_TOLERANCE_SEC) return;
		ranges.push({ start: Math.round(start * ticksPerSecond), end: Math.round(end * ticksPerSecond) });
		removedSec += end - start;
	};
	for (const m of merged) {
		if (m.start > cursor) pushGap({ start: cursor, end: m.start });
		cursor = Math.max(cursor, m.end);
	}
	if (cursor < totalSec) pushGap({ start: cursor, end: totalSec });

	return { ranges, removedSec };
}

/**
 * Pure: resolve each `reorder` op to the moves it implies. An op claims the
 * elements FULLY contained in its [startSec, endSec) span (clip granularity — KTD-2)
 * and shifts each by `targetStartSec - startSec`, preserving relative offsets. Ops
 * with no movement (target === start) or no contained elements yield nothing.
 */
export function planReorderMoves({
	ops,
	ticksPerSecond,
	elements,
}: {
	ops: readonly DirectorOp[];
	ticksPerSecond: number;
	elements: readonly ReorderElement[];
}): ReorderMove[] {
	const moves: ReorderMove[] = [];
	for (const op of ops) {
		if (op.op !== "reorder" || op.targetStartSec == null) continue;
		const spanStart = Math.round(op.startSec * ticksPerSecond);
		const spanEnd = Math.round(op.endSec * ticksPerSecond);
		const deltaTicks = Math.round(
			(op.targetStartSec - op.startSec) * ticksPerSecond,
		);
		if (deltaTicks === 0) continue;
		for (const el of elements) {
			const elEnd = el.startTimeTicks + el.durationTicks;
			if (el.startTimeTicks >= spanStart && elEnd <= spanEnd) {
				moves.push({
					elementId: el.elementId,
					trackId: el.trackId,
					newStartTimeTicks: Math.max(0, el.startTimeTicks + deltaTicks),
				});
			}
		}
	}
	return moves;
}

/** One main/overlay/audio track, as much as the apply reads (wasm-free numbers). */
interface DirectorApplyTrack {
	id: string;
	elements: readonly { id: string; startTime: number; duration: number }[];
}

/**
 * The minimal editor surface `applyDirectorPlan` needs — the active scene's tracks
 * and a command sink. Segregated from the full `EditorCore` (which it stays
 * structurally assignable to — `MediaTime` reads as `number`) so the apply glue is
 * unit-testable with a plain stub. Element times are plain ticks.
 */
export interface DirectorApplyEditor {
	scenes: {
		getActiveScene: () => {
			tracks: {
				main: DirectorApplyTrack;
				overlay: readonly DirectorApplyTrack[];
				audio: readonly DirectorApplyTrack[];
			};
		};
	};
	command: { execute: (args: { command: Command }) => void };
}

/**
 * Apply the accepted ops as one undoable step: a `MoveElementCommand` for the
 * reorders (first) and an all-track `RemoveRangesCommand` for the removals, wrapped
 * in a `BatchCommand`. With no reorders this is byte-identical to the v0 path.
 */
export function applyDirectorPlan({
	editor,
	ops,
	words,
	fps = 30,
	protectedSpansSec = [],
	rejectedSpansSec = [],
}: {
	editor: DirectorApplyEditor;
	ops: readonly DirectorOp[];
	/** Transcript words (seconds), for the sliver word-guard. Absent → no coalescing. */
	words?: readonly WordTiming[];
	/** Project fps, for the sub-floor gap threshold. Defaults to 30. */
	fps?: number;
	/** Spans (seconds) coalescing must never swallow: user-rejected review rows,
	 * emphasis-pause keepers, justify-reverted cuts (review F5). */
	protectedSpansSec?: readonly ProtectedSpanSec[];
	/** Spans of explicitly REJECTED rows (seconds): carved OUT of the final ranges
	 * so reject stays authoritative even when an accepted wider op covers one
	 * (review X6). */
	rejectedSpansSec?: readonly ProtectedSpanSec[];
}): ApplyDirectorPlanResult {
	const { ranges: rawRanges } = planRemovalRanges({
		ops,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	// Choke-point sliver guard (2P-U1): coalesce accepted removals across sub-floor
	// gaps so no shard survives, word-guarded so a real word between two cuts is never
	// swallowed. Fail-open (no words → no merge → footage kept). Every removal source
	// passes through here, so nothing downstream can reintroduce a sliver.
	const floorTicks = Math.round(
		(MIN_SURVIVING_CLIP_FRAMES / (fps > 0 ? fps : 30)) * TICKS_PER_SECOND,
	);
	// Order matters: coalesce first (gap protection consulted), THEN carve rejected
	// spans out, so a swallow can never re-remove footage a rejection carved back.
	const ranges = subtractRemovalRanges({
		ranges: coalesceRemovalRanges({
			ranges: rawRanges,
			words,
			floorTicks,
			ticksPerSecond: TICKS_PER_SECOND,
			protectedSpansSec,
		}),
		spansSec: rejectedSpansSec,
		ticksPerSecond: TICKS_PER_SECOND,
	});

	const tracks = editor.scenes.getActiveScene().tracks;
	const elements: ReorderElement[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const el of track.elements) {
			elements.push({
				elementId: el.id,
				trackId: track.id,
				startTimeTicks: el.startTime,
				durationTicks: el.duration,
			});
		}
	}
	const reorderMoves = planReorderMoves({
		ops,
		ticksPerSecond: TICKS_PER_SECOND,
		elements,
	});

	const commands: Command[] = [];
	if (reorderMoves.length > 0) {
		const moves: PlannedElementMove[] = reorderMoves.map((m) => ({
			sourceTrackId: m.trackId,
			targetTrackId: m.trackId,
			elementId: m.elementId,
			newStartTime: mediaTime({ ticks: m.newStartTimeTicks }),
		}));
		commands.push(new MoveElementCommand({ moves }));
	}
	let removalCommand: RemoveRangesCommand | null = null;
	if (ranges.length > 0) {
		removalCommand = new RemoveRangesCommand({ ranges });
		commands.push(removalCommand);
		// KTD5: after the cuts fragment the timeline, merge adjacent same-source
		// contiguous slices back into single clips (U4). Runs LAST so it reads the
		// post-removal layout, and it is part of THIS batch so the whole recut is one
		// undo. Gated on removals: with nothing cut there is no fragmentation to fix.
		commands.push(new ConsolidateAdjacentClipsCommand());
	}

	if (commands.length === 0) {
		return { cuts: 0, removedSec: 0, reorders: 0, appliedCommand: null };
	}
	const command =
		commands.length === 1 ? commands[0] : new BatchCommand(commands);
	editor.command.execute({ command });

	return {
		cuts: removalCommand ? removalCommand.getRemovedCount() : 0,
		// Report what actually leaves the timeline: coalescing widens the raw op
		// ranges and the rejected-span carve-out (X6) shrinks them, so sum the FINAL
		// ranges instead of trusting the pre-transform op spans.
		removedSec:
			ranges.reduce((acc, r) => acc + (r.end - r.start), 0) / TICKS_PER_SECOND,
		reorders: reorderMoves.length,
		appliedCommand: command,
	};
}

/** Result of applying a Highlight (keep-only) plan. */
export interface ApplyHighlightResult {
	/** Removal ranges applied (the complement of the kept spans). */
	cuts: number;
	/** Total seconds removed. */
	removedSec: number;
	/**
	 * The executed `RemoveRangesCommand`, or null when nothing was applied. Mirrors
	 * `ApplyDirectorPlanResult.appliedCommand` (R1): the docked highlight panel's
	 * revisable-apply flow captures this handle the same way DirectorCutPanel does.
	 */
	appliedCommand: Command | null;
}

/**
 * Apply a Highlight plan: keep `keeps`, remove everything else. The complement is
 * computed by `planKeepInverseRanges` (which THROWS on an empty keep set — the
 * caller surfaces it, never removing the whole timeline) and applied as one
 * `RemoveRangesCommand` (one undo). A full-timeline keep removes nothing.
 */
export function applyHighlightPlan({
	editor,
	keeps,
	totalSec,
}: {
	editor: DirectorApplyEditor;
	keeps: readonly InverseKeepSpan[];
	totalSec: number;
}): ApplyHighlightResult {
	const { ranges, removedSec } = planKeepInverseRanges({
		keeps,
		totalSec,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	if (ranges.length === 0) {
		return { cuts: 0, removedSec: 0, appliedCommand: null };
	}
	const command = new RemoveRangesCommand({ ranges });
	editor.command.execute({ command });
	return { cuts: command.getRemovedCount(), removedSec, appliedCommand: command };
}
