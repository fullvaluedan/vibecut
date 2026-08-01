/**
 * The transcript panel's RESTORE action (T16.2): turn a `planSeamRestore` result
 * into one undoable `RestoreRangeCommand` and keep the lineage journal honest
 * afterwards.
 *
 * JOURNAL RECONCILIATION. T16.1 left this to us, and the choice matters. The
 * journal is a HASH CHAIN (`hashBefore` -> `hashAfter` per entry) and that chain
 * is the only thing that makes undo and redo work without holding command
 * references. Rewriting the earlier removal entries to "subtract" what we just
 * put back would have snapped that chain: the pre-restore timeline would stop
 * being any entry's `hashAfter`, so one Ctrl+Z would land on "cannot-explain"
 * and the panel would demand a full re-transcription. It would also have thrown
 * away the Director category/reason carried by every OTHER seam in the same
 * entry.
 *
 * So a restore APPENDS an entry of its own, carrying `restores` instead of
 * `ranges` (see `beginLineageRestore`). Reading folds the journal in order,
 * adding each entry's removals and subtracting its restores, which makes:
 *   - a partial restore report exactly `remainingRanges` on the next read (the
 *     pipe stays, with the words that are still cut),
 *   - a full restore leave nothing at that seam (the pipe disappears),
 *   - undo/redo of the restore work by the same hash-prefix rule as everything
 *     else, with no bookkeeping of its own,
 *   - remove -> restore -> remove again land on "removed", because the fold is
 *     ordered rather than a single global union.
 */

import type { Command } from "@/commands/base-command";
import {
	RestoreRangeCommand,
	type RestoreRange,
} from "@/commands/timeline/track/restore-range";
import { beginLineageRestore, planSeamRestore, type LineageEditor } from "./lineage";
import type { LineageRestorePlan, LineageSeam } from "./lineage-types";

/**
 * Ticks per second - the same wasm-free local copy `lineage.ts` keeps, so this
 * module stays bun-testable without the opencut-wasm binary.
 */
const TICKS_PER_SECOND = 120_000;

/**
 * Map a restore plan onto the command's ranges.
 *
 * The plan's own `insertAtTicks` anchors EVERY range at the seam's start, which
 * is exact for a one-span seam and wrong for the later spans of a multi-span one
 * (T16.1's note 5). We re-derive the insertion points from the seam instead: the
 * spans are fully removed, so on the current timeline each one sits its
 * predecessor's SURVIVING gap further along than the last. Ranges stay in
 * pre-restore coordinates because `RestoreRangeCommand` applies them from the
 * latest seam backwards.
 */
export function planToRestoreRanges({
	plan,
	seam,
}: {
	plan: LineageRestorePlan;
	seam: LineageSeam;
}): RestoreRange[] {
	const seamAt = Math.round(seam.atSec * TICKS_PER_SECOND);
	let insertAt = seamAt;
	const spans = seam.removedSpans.map((span, index) => {
		if (index > 0) {
			const previous = seam.removedSpans[index - 1];
			insertAt += Math.round(
				(span.startSec - previous.endSec) * TICKS_PER_SECOND,
			);
		}
		return {
			start: Math.round(span.startSec * TICKS_PER_SECOND),
			end: Math.round(span.endSec * TICKS_PER_SECOND),
			insertAt,
		};
	});

	const ranges: RestoreRange[] = [];
	for (const range of plan.sourceRanges) {
		const span = spans.find(
			(candidate) => range.start < candidate.end && candidate.start < range.end,
		);
		if (!span) continue;
		ranges.push({
			insertAt: span.insertAt,
			offset: range.start - span.start,
			duration: range.end - range.start,
			removedTotal: span.end - span.start,
		});
	}
	return ranges;
}

/**
 * The editor slice a restore needs: a command sink, plus the optional lineage
 * surface (project id + active scene) that the real editor always carries and a
 * unit stub may omit, in which case the restore simply is not journaled.
 */
export interface RestoreSeamEditor extends Partial<LineageEditor> {
	command: { execute: (args: { command: Command }) => void };
}

/**
 * Restore a subset (default: all) of a seam's removed words as ONE undoable
 * command, then journal it. `wordStartIndex`/`wordEndIndex` are INCLUSIVE
 * indices into `seam.removedWords`. Returns the plan that was applied, or null
 * when the selection resolves to nothing (no command executed).
 */
export function restoreSeamWords({
	editor,
	seam,
	wordStartIndex,
	wordEndIndex,
}: {
	editor: RestoreSeamEditor;
	seam: LineageSeam;
	wordStartIndex?: number;
	wordEndIndex?: number;
}): LineageRestorePlan | null {
	const plan = planSeamRestore({ seam, wordStartIndex, wordEndIndex });
	if (!plan) return null;
	const ranges = planToRestoreRanges({ plan, seam });
	if (ranges.length === 0) return null;
	// Opened BEFORE the command runs (the pre-edit hash only exists then) and
	// committed after, exactly like `beginLineageRemoval` on the delete path.
	const commitLineage =
		editor.project && editor.scenes
			? beginLineageRestore({
					editor: { project: editor.project, scenes: editor.scenes },
					restoredRanges: plan.sourceRanges,
				})
			: null;
	editor.command.execute({ command: new RestoreRangeCommand({ ranges }) });
	commitLineage?.();
	return plan;
}
