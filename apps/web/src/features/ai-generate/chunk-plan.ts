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
 * Even chunks covering an arbitrary [startSec, endSec] span (absolute timeline
 * seconds). Count is `ceil(span/target)` clamped to MAX_CHUNKS, so every chunk is
 * the same length (no tiny trailing stub) and the union is exactly the span with
 * no gaps or overlaps. Used to scope a run to a selected section of the timeline.
 */
export function planAuthorChunksOver({
	startSec,
	endSec,
	targetSec = TARGET_CHUNK_SEC,
}: {
	startSec: number;
	endSec: number;
	targetSec?: number;
}): AuthorChunk[] {
	const lo = Math.max(0, Math.min(startSec, endSec));
	const hi = Math.max(lo, Math.max(startSec, endSec));
	const span = hi - lo;
	const n = Math.min(Math.max(Math.ceil(span / targetSec), 1), MAX_CHUNKS);
	const len = span / n;
	const chunks: AuthorChunk[] = [];
	for (let i = 0; i < n; i++) {
		const s = lo + i * len;
		// Pin the last edge to the exact end so rounding never leaves a gap.
		const e = i === n - 1 ? hi : lo + (i + 1) * len;
		chunks.push({ index: i, startSec: s, endSec: e, label: fmtRange(s, e) });
	}
	return chunks;
}

/**
 * Even chunks covering [0, totalSec] — the whole-timeline run. Thin wrapper over
 * `planAuthorChunksOver`.
 */
export function planAuthorChunks(
	totalSec: number,
	targetSec = TARGET_CHUNK_SEC,
): AuthorChunk[] {
	return planAuthorChunksOver({ startSec: 0, endSec: Math.max(0, totalSec), targetSec });
}
