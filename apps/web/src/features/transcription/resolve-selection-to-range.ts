import type {
	TranscriptSegmentLite,
	TranscriptWordLite,
} from "./transcript-cache";

export type TranscriptGranularity = "word" | "segment";

/** A contiguous index range over the displayed words (or segments). */
export interface TranscriptSelection {
	startIndex: number;
	endIndex: number;
	granularity: TranscriptGranularity;
}

/** A timeline span in seconds (converted to ticks at the delete boundary). */
export interface TimeRangeSec {
	startSec: number;
	endSec: number;
}

/**
 * Resolve a word/segment index range to a {startSec, endSec} span by reading the
 * matching array's boundaries (KTD1: seconds first, ticks only at the cut). Returns
 * null on an empty or out-of-bounds range (endIndex < startIndex, negative start, or
 * end past the array), or when the requested granularity's array is empty (per KTD4
 * the caller must not offer word selection when words are absent).
 */
export function resolveSelectionToTimeRange({
	selection,
	words,
	segments,
}: {
	selection: TranscriptSelection;
	words: readonly TranscriptWordLite[];
	segments: readonly TranscriptSegmentLite[];
}): TimeRangeSec | null {
	const { startIndex, endIndex, granularity } = selection;
	const items = granularity === "word" ? words : segments;
	if (startIndex < 0 || endIndex < startIndex || endIndex >= items.length) {
		return null;
	}
	const startSec = items[startIndex].start;
	const endSec = items[endIndex].end;
	if (endSec <= startSec) return null;
	return { startSec, endSec };
}
