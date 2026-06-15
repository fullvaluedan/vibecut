/**
 * Pure chunk planner for the authored HyperFrames engine: divide a timeline
 * into sequential segments so each gets its own short composition (graphics
 * across the WHOLE video, small fast renders). No editor/WASM deps — unit-testable.
 */

export interface AuthorChunk {
	index: number;
	startSec: number;
	endSec: number;
	label: string;
}

export const TARGET_CHUNK_SEC = 90; // default run
export const VARIANT_CHUNK_SEC = 150; // coarser for variants (bounds total renders)
export const MAX_CHUNKS = 12;

export function fmtRange(a: number, b: number): string {
	const mmss = (s: number) =>
		`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
	return `${mmss(a)}–${mmss(b)}`;
}

/**
 * Even chunks covering [0, totalSec]. Count is `ceil(total/target)` clamped to
 * MAX_CHUNKS, so every chunk is the same length (no tiny trailing stub) and the
 * union is exactly [0, totalSec] with no gaps or overlaps.
 */
export function planAuthorChunks(
	totalSec: number,
	targetSec = TARGET_CHUNK_SEC,
): AuthorChunk[] {
	const safeTotal = Math.max(0, totalSec);
	const n = Math.min(Math.max(Math.ceil(safeTotal / targetSec), 1), MAX_CHUNKS);
	const len = safeTotal / n;
	const chunks: AuthorChunk[] = [];
	for (let i = 0; i < n; i++) {
		const startSec = i * len;
		// Pin the last edge to the exact total so rounding never leaves a gap.
		const endSec = i === n - 1 ? safeTotal : (i + 1) * len;
		chunks.push({ index: i, startSec, endSec, label: fmtRange(startSec, endSec) });
	}
	return chunks;
}
