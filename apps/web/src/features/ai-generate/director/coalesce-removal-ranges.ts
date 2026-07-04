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
import { spansOverlap, type WordTiming } from "./cut-utils";
import { spanHasContentWord } from "./content-word";

/** A span (seconds) the coalescer must never swallow, whatever the word-guard says. */
export interface ProtectedSpanSec {
	startSec: number;
	endSec: number;
}

/**
 * Carve every `spans` window OUT of `ranges` (review X6). A review row the user
 * explicitly REJECTED must survive apply even when an accepted WIDER op (a
 * second-pass repeat legitimately containing pass-1 micro-cuts) directly covers
 * it: gap protection cannot help there because no gap exists, so subtraction is
 * what makes reject authoritative. Ticks in, ticks out; empty leftovers dropped.
 */
export function subtractRemovalRanges({
	ranges,
	spansSec,
	ticksPerSecond,
}: {
	ranges: readonly TimeRange[];
	spansSec: readonly ProtectedSpanSec[];
	ticksPerSecond: number;
}): TimeRange[] {
	if (spansSec.length === 0) return [...ranges];
	const sub = spansSec
		.map((s) => ({
			start: Math.round(s.startSec * ticksPerSecond),
			end: Math.round(s.endSec * ticksPerSecond),
		}))
		.filter((s) => s.end > s.start)
		.sort((a, b) => a.start - b.start);
	const out: TimeRange[] = [];
	for (const range of ranges) {
		let cursor = range.start;
		for (const s of sub) {
			if (s.end <= cursor) continue;
			if (s.start >= range.end) break;
			if (s.start > cursor) out.push({ start: cursor, end: s.start });
			cursor = Math.max(cursor, s.end);
			if (cursor >= range.end) break;
		}
		if (cursor < range.end) out.push({ start: cursor, end: range.end });
	}
	return out;
}

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
 *
 * `protectedSpansSec` (review F5): a gap overlapping any of these is NEVER swallowed,
 * word-guard or not. The word-guard alone cannot protect a review row the user
 * explicitly UNCHECKED (a filler is not a content word), a keeper-protected emphasis
 * pause (word-free by definition), or a span justifyCuts deliberately reverted - a
 * merge across any of those silently deletes footage a human or a guard decided to
 * keep.
 */
export function coalesceRemovalRanges({
	ranges,
	words,
	floorTicks,
	ticksPerSecond,
	protectedSpansSec = [],
}: {
	ranges: readonly TimeRange[];
	words?: readonly WordTiming[];
	floorTicks: number;
	ticksPerSecond: number;
	protectedSpansSec?: readonly ProtectedSpanSec[];
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
		const gapStartSec = prev.end / ticksPerSecond;
		const gapEndSec = next.start / ticksPerSecond;
		const gapProtected = protectedSpansSec.some((p) =>
			spansOverlap(p, { startSec: gapStartSec, endSec: gapEndSec }),
		);
		const swallow =
			hasWords &&
			!gapProtected &&
			gapTicks < floorTicks &&
			!spanHasContentWord({
				startSec: gapStartSec,
				endSec: gapEndSec,
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
