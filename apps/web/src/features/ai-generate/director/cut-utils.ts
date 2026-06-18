/**
 * Shared helpers for the deterministic Director cut detectors (duplicate-words,
 * filler-words, pacing). Pure + wasm-free so each detector stays unit-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";

/** One transcript word/segment with timeline-relative timing (seconds). */
export interface WordTiming {
	text: string;
	start: number;
	end: number;
}

/** Lowercase + strip surrounding punctuation; keep inner apostrophes/digits. */
export function normalizeWord(text: string): string {
	return text
		.toLowerCase()
		.replace(/^[^a-z0-9']+/, "")
		.replace(/[^a-z0-9']+$/, "");
}

/** djb2 → base36. Detectors prefix the input so ids don't collide across kinds. */
export function stableCutId(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * Merge deterministic detector cuts into a planner's ops, dropping any that
 * overlap an existing removal (the LLM already cut that span). Returns the
 * combined op list in time order.
 */
export function mergeDetectedCuts({
	planOps,
	extraOps,
}: {
	planOps: DirectorOp[];
	extraOps: DirectorOp[];
}): DirectorOp[] {
	const removals = planOps.filter(
		(op) => op.op === "cut" || op.op === "take_select",
	);
	const overlaps = (op: DirectorOp): boolean =>
		removals.some((r) => op.startSec < r.endSec && r.startSec < op.endSec);
	const fresh = extraOps.filter((op) => !overlaps(op));
	return [...planOps, ...fresh].sort((a, b) => a.startSec - b.startSec);
}
