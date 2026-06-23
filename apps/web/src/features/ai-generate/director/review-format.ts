/**
 * Pure display logic for the Director Review modal (U7). Kept out of the React
 * component so it is bun-testable (the dialog render itself is live-verified —
 * bun has no DOM). Centralizes the per-op badge + the rejected-state hint that
 * tells the user what KEEPING a flagged duplicate actually means.
 */

import type { DirectorOp } from "@framecut/hf-bridge";

/**
 * Format a timeline position (seconds) as M:SS.s — minutes:seconds, one decimal
 * kept so sub-second cut spans (e.g. a 0.5s pause) stay distinguishable rather
 * than collapsing to the same whole second. 108 → "1:48.0", 13.8 → "0:13.8".
 */
export function formatTimecode(sec: number): string {
	const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
	const minutes = Math.floor(safe / 60);
	const seconds = safe - minutes * 60;
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** A start–end span as "M:SS.s–M:SS.s" for the review rows. */
export function formatTimeRange({
	startSec,
	endSec,
}: {
	startSec: number;
	endSec: number;
}): string {
	return `${formatTimecode(startSec)}–${formatTimecode(endSec)}`;
}

/** What to render for one reviewed op. */
export interface ReviewOpDisplay {
	/** Primary badge for the op kind (Cut / Take / Reorder / Keep). */
	badge: string;
	/** Secondary category badge, when the category adds information the op kind doesn't. */
	categoryBadge?: string;
	/**
	 * Short note shown when a de-dup removal is REJECTED, so the user understands
	 * the consequence (rejecting a take_select keeps BOTH takes). Empty otherwise.
	 */
	rejectedHint: string;
}

const OP_BADGE: Record<DirectorOp["op"], string> = {
	cut: "Cut",
	take_select: "Take",
	reorder: "Reorder",
	keep: "Keep",
};

// "take" is intentionally absent — the `take_select` op badge already says "Take".
const CATEGORY_BADGE: Partial<Record<NonNullable<DirectorOp["category"]>, string>> = {
	repeat: "Repeat",
	vision: "Vision",
	deadair: "Dead air",
	noise: "Noise",
};

function isRemoval(op: DirectorOp): boolean {
	return op.op === "cut" || op.op === "take_select";
}

/**
 * Describe one op for the review row. The `rejectedHint` only fires for the
 * destructive de-dup ops (take/repeat), where "rejected" means "keep the
 * duplicate" — a non-obvious outcome the plain checkbox doesn't communicate.
 */
export function describeReviewOp({
	op,
	accepted,
}: {
	op: DirectorOp;
	accepted: boolean;
}): ReviewOpDisplay {
	const badge = OP_BADGE[op.op];
	const categoryBadge = op.category ? CATEGORY_BADGE[op.category] : undefined;

	let rejectedHint = "";
	if (!accepted && isRemoval(op)) {
		if (op.op === "take_select" || op.category === "take") {
			rejectedHint = "Keeping both takes";
		} else if (op.category === "repeat") {
			rejectedHint = "Keeping the restatement";
		}
	}

	return { badge, categoryBadge, rejectedHint };
}
