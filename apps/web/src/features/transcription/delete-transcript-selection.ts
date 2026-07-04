import {
	RemoveRangesCommand,
	type TimeRange,
} from "@/commands/timeline/track/remove-ranges";
import type { Command } from "@/commands/base-command";
import { TICKS_PER_SECOND } from "@/wasm";
import type {
	TranscriptSegmentLite,
	TranscriptWordLite,
} from "./transcript-cache";
import {
	resolveSelectionToTimeRange,
	type TimeRangeSec,
	type TranscriptSelection,
} from "./resolve-selection-to-range";

/** The slice of the editor this needs: a command sink (mirrors apply-plan.ts). */
export interface DeleteSelectionEditor {
	command: { execute: (args: { command: Command }) => void };
}

/**
 * Ripple-delete the timeline span under a transcript selection as ONE undoable
 * command. Resolves the index range to seconds (KTD1), converts to ticks at the
 * boundary (matching apply-plan.ts), and runs an all-track RemoveRangesCommand with
 * no trackId, so it ripples every track (KTD3). Returns the removed span in seconds,
 * or null when the selection resolves to nothing (no command executed).
 */
export function deleteTranscriptSelection({
	editor,
	selection,
	words,
	segments,
}: {
	editor: DeleteSelectionEditor;
	selection: TranscriptSelection;
	words: readonly TranscriptWordLite[];
	segments: readonly TranscriptSegmentLite[];
}): TimeRangeSec | null {
	const range = resolveSelectionToTimeRange({ selection, words, segments });
	if (!range) return null;
	const ticks: TimeRange = {
		start: Math.round(range.startSec * TICKS_PER_SECOND),
		end: Math.round(range.endSec * TICKS_PER_SECOND),
	};
	editor.command.execute({
		command: new RemoveRangesCommand({ ranges: [ticks] }),
	});
	return range;
}
