/**
 * Refine raw silence ranges before they're cut (FrameCut, Issue 2). Two guards,
 * both pure + wasm-free so they're bun-testable:
 *
 *  (a) NEVER delete an entire VIDEO clip on low audio. A quiet showcase / b-roll
 *      clip reads as "silent" (low RMS) but is intentional footage — silence
 *      removal that would remove a whole video clip is dropped over that clip.
 *  (b) NO 4-frame remnants. Remove-silences pads each range inward by ~0.15s to
 *      keep breathing room around speech; at a CLIP boundary that padding has
 *      nothing to protect and leaves a tiny sliver. Snapping a range edge that
 *      lands within `snapSec` just inside a clip boundary out to that boundary
 *      makes the cut swallow the (silent) sliver instead of leaving it.
 */

import type { SceneTracks } from "@/timeline";

export interface SecRange {
	start: number;
	end: number;
}

export interface ClipSpanSec {
	startSec: number;
	endSec: number;
}

/** Timeline spans (seconds) of every VIDEO clip — the footage worth protecting. */
export function collectVideoClipSpansSec({
	tracks,
	ticksPerSecond,
}: {
	tracks: SceneTracks;
	ticksPerSecond: number;
}): ClipSpanSec[] {
	const spans: ClipSpanSec[] = [];
	for (const track of [tracks.main, ...tracks.overlay]) {
		if (track.type !== "video") continue;
		for (const element of track.elements) {
			if (element.type !== "video") continue;
			spans.push({
				startSec: element.startTime / ticksPerSecond,
				endSec: (element.startTime + element.duration) / ticksPerSecond,
			});
		}
	}
	return spans;
}

/**
 * Apply both guards to the detected silent ranges. Snapping runs first so a range
 * that padding left just inside a clip edge becomes flush with it; then any range
 * that would fully cover a video clip has that clip subtracted out (the clip
 * survives, the silence around it on other tracks still cuts). Finally tiny
 * leftovers below `minSec` are dropped.
 */
export function refineSilenceRanges({
	ranges,
	clipSpans,
	snapSec,
	minSec,
}: {
	ranges: readonly SecRange[];
	clipSpans: readonly ClipSpanSec[];
	snapSec: number;
	minSec: number;
}): SecRange[] {
	const clipStarts = clipSpans.map((c) => c.startSec);
	const clipEnds = clipSpans.map((c) => c.endSec);

	const snapped = ranges
		.map((range) => {
			let start = range.start;
			for (const clipStart of clipStarts) {
				// range start sits just INSIDE a clip start → extend the cut back to it
				if (start - clipStart >= 0 && start - clipStart <= snapSec) {
					start = clipStart;
					break;
				}
			}
			let end = range.end;
			for (const clipEnd of clipEnds) {
				// range end sits just INSIDE a clip end → extend the cut out to it
				if (clipEnd - end >= 0 && clipEnd - end <= snapSec) {
					end = clipEnd;
					break;
				}
			}
			return { start, end };
		})
		.filter((range) => range.end > range.start);

	const out: SecRange[] = [];
	for (const range of snapped) {
		const covered = clipSpans
			.filter((c) => range.start <= c.startSec && range.end >= c.endSec)
			.sort((a, b) => a.startSec - b.startSec);
		if (covered.length === 0) {
			out.push(range);
			continue;
		}
		// Subtract each fully-covered video clip — keep only the silence around it.
		let cursor = range.start;
		for (const clip of covered) {
			if (clip.startSec > cursor) out.push({ start: cursor, end: clip.startSec });
			cursor = Math.max(cursor, clip.endSec);
		}
		if (cursor < range.end) out.push({ start: cursor, end: range.end });
	}

	return out.filter((range) => range.end - range.start >= minSec);
}
