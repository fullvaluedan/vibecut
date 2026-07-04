/**
 * Pure preview-stat formatting for the Highlight review surface (U8). Kept out of
 * the React dialog so it is bun-testable (the dialog render is live-verified).
 * Produces the "keeping N of M · Xs of Ys (−Z%)" summary the user vets before the
 * destructive inverse apply.
 */

export interface HighlightPreview {
	/** Number of kept spans the user will keep. */
	keptCount: number;
	/** Number of candidate segments considered. */
	totalCount: number;
	/** Total seconds kept. */
	keptSec: number;
	/** Total timeline seconds. */
	totalSec: number;
}

/** Percent of the timeline that will be REMOVED, clamped to [0,100]. */
export function removedPercent({ keptSec, totalSec }: { keptSec: number; totalSec: number }): number {
	if (totalSec <= 0) return 0;
	const pct = (1 - keptSec / totalSec) * 100;
	return Math.max(0, Math.min(100, Math.round(pct)));
}

/** "keeping 6 of 40 · 58.0s of 1240.0s (−95%)" — the Highlight modal summary. */
export function formatHighlightPreview(p: HighlightPreview): string {
	const removed = removedPercent({ keptSec: p.keptSec, totalSec: p.totalSec });
	return `keeping ${p.keptCount} of ${p.totalCount} · ${p.keptSec.toFixed(1)}s of ${p.totalSec.toFixed(1)}s (−${removed}%)`;
}
