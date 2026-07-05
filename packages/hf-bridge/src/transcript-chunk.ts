// --- Transcript chunking for over-budget LLM passes (FrameCut, U5 / R6) ---
//
// A 30+ minute recording's transcript blows the prompt budget, and a truncated
// prompt silently drops the tail (no cuts there). This splits the numbered
// transcript into OVERLAPPING windows: each window carries the last `overlapLines`
// lines of the previous one, so a take or restatement that straddles a boundary is
// fully visible inside at least one window instead of being sawn in half. The pass
// runs per window; `dedupeByKey` collapses an op the overlap surfaced in two
// windows back to one before it reaches review.
//
// Pure + wasm-free so `bun test` covers it whole.

/** The minimum a chunkable line must carry: an id and its text (for sizing). */
export interface ChunkLine {
	lineId: string;
	text: string;
}

/**
 * Split `lines` into windows no larger than `maxChars` of text, each overlapping
 * the previous by `overlapLines` lines. A window only splits once it holds MORE
 * than `overlapLines` lines (so progress is always made and the overlap can't
 * livelock); a single line longer than `maxChars` still gets its own window rather
 * than being dropped. With `lines` fitting in one budget this returns `[lines]`.
 */
export function chunkTranscriptLines<T extends ChunkLine>({
	lines,
	maxChars,
	overlapLines,
}: {
	lines: readonly T[];
	maxChars: number;
	overlapLines: number;
}): T[][] {
	if (lines.length === 0) return [];
	const overlap = Math.max(0, overlapLines);
	const windows: T[][] = [];
	let current: T[] = [];
	let currentChars = 0;

	for (const line of lines) {
		const lineChars = line.text.length;
		if (current.length > overlap && currentChars + lineChars > maxChars) {
			windows.push(current);
			// Seed the next window with the tail of the one we just closed.
			const carried = overlap > 0 ? current.slice(current.length - overlap) : [];
			current = [...carried];
			currentChars = carried.reduce((sum, l) => sum + l.text.length, 0);
		}
		current.push(line);
		currentChars += lineChars;
	}
	if (current.length > 0) windows.push(current);
	return windows;
}

/**
 * True when the transcript exceeds the single-prompt budget and should be chunked.
 * Sums line text length (the dominant prompt cost); the caller adds its own
 * per-line signal/formatting overhead by choosing a conservative `maxChars`.
 */
export function transcriptExceedsBudget({
	lines,
	maxChars,
}: {
	lines: readonly ChunkLine[];
	maxChars: number;
}): boolean {
	let total = 0;
	for (const line of lines) {
		total += line.text.length;
		if (total > maxChars) return true;
	}
	return false;
}

/**
 * Drop later items whose key collides with an earlier one, keeping input order.
 * The overlap between windows re-surfaces the same op in two windows; keying by a
 * stable reference (e.g. the id/index span it cut) collapses those to one before
 * review, so an overlapping boundary never doubles a cut.
 */
export function dedupeByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = keyOf(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
