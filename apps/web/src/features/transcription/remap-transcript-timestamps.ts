/**
 * KTD5: after a ripple-delete the live timeline shifts everything downstream left
 * by the removed duration, so the in-memory transcript used to resolve the NEXT
 * selection must shift by the same amount, or a second delete before a refresh
 * resolves against stale (too-large) coordinates and cuts the wrong footage.
 *
 * Pure and local: subtract `removedDurationSec` from the start/end of every item
 * whose `start` is at or after the deleted range's end. Items inside or before the
 * deleted range are left as-is (the deleted ones are struck in the view but never
 * resolved again). Generic over words and segments so both arrays remap identically;
 * it never touches the persisted transcript cache.
 */
export function remapTranscriptTimestamps<T extends { start: number; end: number }>({
	items,
	deletedEndSec,
	removedDurationSec,
}: {
	items: readonly T[];
	deletedEndSec: number;
	removedDurationSec: number;
}): T[] {
	return items.map((item) =>
		item.start >= deletedEndSec
			? {
					...item,
					start: item.start - removedDurationSec,
					end: item.end - removedDurationSec,
				}
			: item,
	);
}
