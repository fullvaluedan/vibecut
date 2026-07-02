import type {
	TranscriptGranularity,
	TranscriptSelection,
} from "./resolve-selection-to-range";

/**
 * Normalize a drag (anchor index -> focus index) into an ordered selection. A
 * backward drag (focus < anchor) still yields startIndex <= endIndex; a single
 * click (anchor === focus) selects that one item. Index-based per KTD2: the
 * native Selection API is deliberately not used.
 */
export function normalizeSelection({
	anchorIndex,
	focusIndex,
	granularity,
}: {
	anchorIndex: number;
	focusIndex: number;
	granularity: TranscriptGranularity;
}): TranscriptSelection {
	return {
		startIndex: Math.min(anchorIndex, focusIndex),
		endIndex: Math.max(anchorIndex, focusIndex),
		granularity,
	};
}
