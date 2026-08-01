/**
 * Where the transcript draws its RED PIPE BARS (T16.2). A seam is a run of
 * removed words sitting between two survivors; the pipe goes immediately BEFORE
 * the surviving item that follows it.
 *
 * Word-level rendering can use the seam's own `afterWordIndex` directly - the
 * panel renders the lineage view's `words`, which is the very array that index
 * counts into. Segment-level (degraded) rendering has no such index, so the pipe
 * is placed by TIME instead: before the first segment that starts at or after
 * the seam. A seam that falls strictly inside a surviving segment cannot be drawn
 * between two segments at all, so it attaches to the following segment's start,
 * which is the closest honest position available without word timings.
 *
 * Pure and wasm-free so the placement is unit-testable on plain numbers.
 */

import type { LineageSeam } from "./lineage-types";
import type { TranscriptGranularity } from "./resolve-selection-to-range";

/** Floating-point slack for the segment-boundary comparison. */
const EPS = 1e-6;

/** One pipe: which seam it opens, and the item index it is drawn before. */
export interface SeamMarker {
	seamId: string;
	/** Index into the rendered items; `items.length` for a trailing pipe. */
	beforeIndex: number;
}

/** One rendered transcript item, as much of it as the placement reads. */
interface TimedItem {
	start: number;
}

export function deriveSeamMarkers({
	seams,
	items,
	granularity,
}: {
	seams: readonly LineageSeam[];
	items: readonly TimedItem[];
	granularity: TranscriptGranularity;
}): SeamMarker[] {
	const markers = seams.map((seam) => {
		if (granularity === "word") {
			return {
				seamId: seam.id,
				beforeIndex: Math.max(0, Math.min(items.length, seam.afterWordIndex)),
			};
		}
		const found = items.findIndex((item) => item.start + EPS >= seam.atSec);
		return { seamId: seam.id, beforeIndex: found === -1 ? items.length : found };
	});
	return markers.sort((a, b) => a.beforeIndex - b.beforeIndex);
}

/** The markers grouped by the item index they precede, for the renderer. */
export function groupSeamMarkers(
	markers: readonly SeamMarker[],
): Map<number, string[]> {
	const byIndex = new Map<number, string[]>();
	for (const marker of markers) {
		const existing = byIndex.get(marker.beforeIndex);
		if (existing) existing.push(marker.seamId);
		else byIndex.set(marker.beforeIndex, [marker.seamId]);
	}
	return byIndex;
}
