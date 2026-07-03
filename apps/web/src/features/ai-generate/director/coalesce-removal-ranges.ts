/**
 * Choke-point sliver guard (2P-U1, KTD1/KTD2). Every Director removal - cut,
 * take_select, context, all of it - flows through `planRemovalRanges` into a single
 * `RemoveRangesCommand`. Two accepted removals landing a few frames apart used to
 * leave that few-frame gap as its own surviving micro-clip (a shard of an "um" or a
 * repeat). This coalesces adjacent removals across a SUB-FLOOR gap into one range so
 * the shard leaves too - but only when word timings PROVE the gap holds no complete
 * content word, so a real word between two cuts is never swallowed.
 *
 * Pure + wasm-free → bun-testable. Injectable word list + ticksPerSecond.
 */

import type { TimeRange } from "@/commands/timeline/track/remove-ranges";
import type { WordTiming } from "./cut-utils";
import { spanHasContentWord } from "./content-word";

/**
 * Coalesce accepted removal ranges (ticks) across sub-floor gaps. Sorts the ranges,
 * walks adjacent pairs, and merges `prev`+`next` when they overlap/touch, OR when the
 * retained gap between them is shorter than `floorTicks` AND contains no complete
 * content word. Merging is transitive (a chain of small-gap cuts collapses to one)
 * and idempotent. Degenerate ranges (non-positive width) are dropped.
 *
 * Fail-open: with no `words`, sub-floor gaps are NEVER swallowed (footage is kept) -
 * a merge requires positive proof the gap is content-free, which absent words we
 * cannot have.
 */
export function coalesceRemovalRanges({
	ranges,
	words,
	floorTicks,
	ticksPerSecond,
}: {
	ranges: readonly TimeRange[];
	words?: readonly WordTiming[];
	floorTicks: number;
	ticksPerSecond: number;
}): TimeRange[] {
	const sorted = ranges
		.filter((r) => r.end > r.start)
		.map((r) => ({ start: r.start, end: r.end }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	if (sorted.length === 0) return [];

	const hasWords = !!words && words.length > 0;
	const out: { start: number; end: number }[] = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i];
		const prev = out[out.length - 1];

		// Overlapping / touching removals always merge - there is no retained gap to
		// keep, so the word-guard doesn't apply.
		if (next.start <= prev.end) {
			prev.end = Math.max(prev.end, next.end);
			continue;
		}

		const gapTicks = next.start - prev.end;
		const swallow =
			hasWords &&
			gapTicks < floorTicks &&
			!spanHasContentWord({
				startSec: prev.end / ticksPerSecond,
				endSec: next.start / ticksPerSecond,
				words,
			});
		if (swallow) {
			prev.end = Math.max(prev.end, next.end);
		} else {
			out.push(next);
		}
	}
	return out;
}
