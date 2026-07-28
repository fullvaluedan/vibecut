/**
 * Which transcript item (word or segment) is playing at `timeSec`, or null
 * when playback is in a gap between items (silence, or before/after the
 * transcript). Binary search over `items` (already chronological and
 * non-overlapping, straight from the Whisper/cloud result) so the playhead
 * subscription in assets-view.tsx stays cheap even on a long, word-level
 * transcript with thousands of entries updating every animation frame.
 */
export function findActiveTranscriptIndex({
	items,
	timeSec,
}: {
	items: readonly { start: number; end: number }[];
	timeSec: number;
}): number | null {
	let low = 0;
	let high = items.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const item = items[mid];
		if (timeSec < item.start) {
			high = mid - 1;
		} else if (timeSec >= item.end) {
			low = mid + 1;
		} else {
			return mid;
		}
	}
	return null;
}
