/**
 * Pure display logic for the Director Review modal (U7). Kept out of the React
 * component so it is bun-testable (the dialog render itself is live-verified —
 * bun has no DOM). Centralizes the per-op badge + the rejected-state hint that
 * tells the user what KEEPING a flagged duplicate actually means.
 */

import type { DirectorOp } from "@framecut/hf-bridge";

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
