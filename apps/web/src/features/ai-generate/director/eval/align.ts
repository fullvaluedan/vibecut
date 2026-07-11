/**
 * Golden-footage eval, stage 1: derive ground-truth cut labels by aligning the
 * transcript of Dan's RAW footage against the transcript of his FINISHED edit.
 * Whatever survived is a "keep" label, whatever vanished is a "cut" label —
 * the finished edit IS the ground truth, no manual marking, no model ever
 * sees a frame.
 *
 * Alignment is patience-diff style: words unique to both windows anchor the
 * match (LIS over anchor pairs), gaps between anchors fall back to LCS DP.
 * Transcription noise is separated from real cuts by GAP SYMMETRY, not
 * length: a raw-side gap with an EMPTY final-side gap is a deletion (a real
 * cut, even a single "um"); a raw gap faced by different final words at the
 * same position is a substitution (the transcriber misheard; the content
 * survived, so it is NOT a cut).
 */
import type { TranscriptionWord } from "@/transcription/types";

export interface TruthCutSpan {
	/** Inclusive word-index range into the RAW transcript. */
	startIndex: number;
	endIndex: number;
	/** Times on the raw timeline, from the raw word timestamps. */
	startSec: number;
	endSec: number;
	text: string;
}

export interface AlignmentResult {
	/** Per raw word: does its content survive into the final edit? */
	rawKept: boolean[];
	/** Ground-truth cut spans (deletion runs), merged and time-stamped. */
	truthCutSpans: TruthCutSpan[];
	/** Raw words judged mis-transcribed (substitution) — kept, but counted so
	 * a noisy transcript pair is visible in the report. */
	substitutionWords: number;
	/** Final-side words with no raw counterpart (added VO/b-roll audio) —
	 * ignored for labels but reported. */
	finalOnlyWords: number;
	/** Raw words that vanish from their original spot but REAPPEAR elsewhere in
	 * the final (a reorder, not a cut) — kept, excluded from truth cuts, but
	 * counted so a heavily-reordered edit is visible in the report (R3). */
	movedWords: number;
	/** Raw spans relabeled kept/moved by the reorder pass — reported so a move
	 * can be spot-checked against the videos. */
	movedSpans: TruthCutSpan[];
}

/** A raw run must carry at least this many content words to pair as a MOVE —
 * shorter runs are stock phrases ("so the first step is") that recur by chance,
 * so a short reappearance stays a cut under the old deletion semantics (R3). */
const MIN_MOVE_RUN_WORDS = 5;

function normalizeToken(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/** Longest increasing subsequence (by second coordinate) over anchor pairs
 * already sorted by first coordinate — classic patience core, O(n log n). */
function longestIncreasingRun(
	pairs: { a: number; b: number }[],
): { a: number; b: number }[] {
	const tailIdx: number[] = [];
	const prev = new Array<number>(pairs.length).fill(-1);
	for (let i = 0; i < pairs.length; i++) {
		const b = pairs[i].b;
		let lo = 0;
		let hi = tailIdx.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pairs[tailIdx[mid]].b < b) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tailIdx[lo - 1];
		tailIdx[lo] = i;
	}
	const out: { a: number; b: number }[] = [];
	let k = tailIdx.length > 0 ? tailIdx[tailIdx.length - 1] : -1;
	while (k >= 0) {
		out.push(pairs[k]);
		k = prev[k];
	}
	return out.reverse();
}

/** LCS DP match within a small window; marks matched index pairs. */
function lcsMatch(
	rawTokens: string[],
	finalTokens: string[],
	rawStart: number,
	rawEnd: number,
	finalStart: number,
	finalEnd: number,
	rawMatched: boolean[],
	finalMatched: boolean[],
): void {
	const n = rawEnd - rawStart;
	const m = finalEnd - finalStart;
	if (n <= 0 || m <= 0) return;
	// dp[(i)*(m+1)+j] = LCS length of raw[rawStart..rawStart+i) vs final[..+j)
	const dp = new Int32Array((n + 1) * (m + 1));
	for (let i = 1; i <= n; i++) {
		const rt = rawTokens[rawStart + i - 1];
		for (let j = 1; j <= m; j++) {
			dp[i * (m + 1) + j] =
				rt === finalTokens[finalStart + j - 1]
					? dp[(i - 1) * (m + 1) + (j - 1)] + 1
					: Math.max(dp[(i - 1) * (m + 1) + j], dp[i * (m + 1) + (j - 1)]);
		}
	}
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (rawTokens[rawStart + i - 1] === finalTokens[finalStart + j - 1]) {
			rawMatched[rawStart + i - 1] = true;
			finalMatched[finalStart + j - 1] = true;
			i--;
			j--;
		} else if (dp[(i - 1) * (m + 1) + j] >= dp[i * (m + 1) + (j - 1)]) {
			i--;
		} else {
			j--;
		}
	}
}

/** Cap on LCS window size (cells). Windows bigger than this with no anchors
 * are left unmatched — with dense speech vocabulary this effectively never
 * happens, and leaving it unmatched is the conservative direction (the gap
 * shows up as a substitution, i.e. "kept", never as a fabricated cut). */
const MAX_LCS_CELLS = 250_000;

function matchWindow(
	rawTokens: string[],
	finalTokens: string[],
	rawStart: number,
	rawEnd: number,
	finalStart: number,
	finalEnd: number,
	rawMatched: boolean[],
	finalMatched: boolean[],
): void {
	const n = rawEnd - rawStart;
	const m = finalEnd - finalStart;
	if (n <= 0 || m <= 0) return;

	if (n * m <= MAX_LCS_CELLS) {
		lcsMatch(
			rawTokens, finalTokens,
			rawStart, rawEnd, finalStart, finalEnd,
			rawMatched, finalMatched,
		);
		return;
	}

	// Patience anchors: tokens occurring exactly once in EACH window.
	const rawCount = new Map<string, number>();
	const rawPos = new Map<string, number>();
	for (let i = rawStart; i < rawEnd; i++) {
		const t = rawTokens[i];
		if (!t) continue;
		rawCount.set(t, (rawCount.get(t) ?? 0) + 1);
		rawPos.set(t, i);
	}
	const finalCount = new Map<string, number>();
	const finalPos = new Map<string, number>();
	for (let j = finalStart; j < finalEnd; j++) {
		const t = finalTokens[j];
		if (!t) continue;
		finalCount.set(t, (finalCount.get(t) ?? 0) + 1);
		finalPos.set(t, j);
	}
	const anchorPairs: { a: number; b: number }[] = [];
	for (const [t, c] of rawCount) {
		if (c === 1 && finalCount.get(t) === 1) {
			anchorPairs.push({ a: rawPos.get(t)!, b: finalPos.get(t)! });
		}
	}
	anchorPairs.sort((x, y) => x.a - y.a);
	const anchors = longestIncreasingRun(anchorPairs);

	if (anchors.length === 0) {
		// No unique common vocabulary in an oversized window: leave unmatched
		// (conservative — see MAX_LCS_CELLS note).
		return;
	}

	let prevRaw = rawStart;
	let prevFinal = finalStart;
	for (const anchor of anchors) {
		matchWindow(
			rawTokens, finalTokens,
			prevRaw, anchor.a, prevFinal, anchor.b,
			rawMatched, finalMatched,
		);
		rawMatched[anchor.a] = true;
		finalMatched[anchor.b] = true;
		prevRaw = anchor.a + 1;
		prevFinal = anchor.b + 1;
	}
	matchWindow(
		rawTokens, finalTokens,
		prevRaw, rawEnd, prevFinal, finalEnd,
		rawMatched, finalMatched,
	);
}

export function alignTranscripts({
	rawWords,
	finalWords,
}: {
	rawWords: TranscriptionWord[];
	finalWords: TranscriptionWord[];
}): AlignmentResult {
	const rawTokens = rawWords.map((w) => normalizeToken(w.text));
	const finalTokens = finalWords.map((w) => normalizeToken(w.text));
	const rawMatched = new Array<boolean>(rawWords.length).fill(false);
	const finalMatched = new Array<boolean>(finalWords.length).fill(false);

	// Punctuation-only tokens carry no content — never let them decide labels.
	for (let i = 0; i < rawTokens.length; i++) {
		if (!rawTokens[i]) rawMatched[i] = true;
	}
	for (let j = 0; j < finalTokens.length; j++) {
		if (!finalTokens[j]) finalMatched[j] = true;
	}

	matchWindow(
		rawTokens, finalTokens,
		0, rawWords.length, 0, finalWords.length,
		rawMatched, finalMatched,
	);

	// Walk both sides in lockstep to classify each unmatched RAW run by the
	// final-side gap it faces: empty final gap = deletion (CUT); non-empty =
	// substitution (misheard, KEPT).
	const rawKept = new Array<boolean>(rawWords.length).fill(true);
	let substitutionWords = 0;
	let finalOnlyWords = 0;
	let i = 0;
	let j = 0;
	while (i < rawWords.length || j < finalWords.length) {
		if (i < rawWords.length && rawMatched[i]) {
			// Advance the final cursor past its own unmatched run (final-only
			// insertions) up to the word this raw word matched.
			while (j < finalWords.length && !finalMatched[j]) {
				finalOnlyWords++;
				j++;
			}
			i++;
			if (j < finalWords.length) j++;
			continue;
		}
		if (i >= rawWords.length) {
			if (!finalMatched[j]) finalOnlyWords++;
			j++;
			continue;
		}
		// Unmatched raw run: collect it and the facing unmatched final run.
		const runStart = i;
		while (i < rawWords.length && !rawMatched[i]) i++;
		let facingFinal = 0;
		while (j < finalWords.length && !finalMatched[j]) {
			facingFinal++;
			j++;
		}
		if (facingFinal > 0) {
			// Substitution: the content survived, the transcriber disagreed.
			substitutionWords += i - runStart;
		} else {
			for (let k = runStart; k < i; k++) rawKept[k] = false;
		}
	}

	// Move-aware pass (R3): a run cut from one place in RAW that REAPPEARS as a
	// final-only insertion elsewhere is a REORDER, not a cut — the global diff
	// can't align it (it would break the monotonic anchor chain), so it lands as
	// a raw deletion AND a final-only run. Pair unmatched raw runs with unmatched
	// final runs by identical normalized content-token text (>= MIN_MOVE_RUN_WORDS
	// words, greedy longest-first, each final run consumed at most once), relabel
	// the raw run kept/moved, and drop the final run from the final-only count.
	const contentTokens = (
		tokens: string[],
		start: number,
		end: number,
	): string[] => {
		const out: string[] = [];
		for (let k = start; k < end; k++) if (tokens[k]) out.push(tokens[k]);
		return out;
	};
	// Unmatched raw runs (the deletion runs just labeled above).
	const rawRuns: { start: number; end: number; key: string; len: number }[] = [];
	for (let k = 0; k < rawWords.length; k++) {
		if (rawKept[k]) continue;
		const start = k;
		while (k < rawWords.length && !rawKept[k]) k++;
		const toks = contentTokens(rawTokens, start, k);
		rawRuns.push({ start, end: k, key: toks.join(""), len: toks.length });
	}
	// Unmatched final runs, indexed by their content-token text for O(1) pairing.
	const finalRunsByKey = new Map<
		string,
		{ start: number; end: number; len: number }[]
	>();
	for (let j = 0; j < finalWords.length; j++) {
		if (finalMatched[j]) continue;
		const start = j;
		while (j < finalWords.length && !finalMatched[j]) j++;
		const toks = contentTokens(finalTokens, start, j);
		if (toks.length < MIN_MOVE_RUN_WORDS) continue;
		const key = toks.join("");
		const list = finalRunsByKey.get(key) ?? [];
		list.push({ start, end: j, len: toks.length });
		finalRunsByKey.set(key, list);
	}
	const movedSpans: TruthCutSpan[] = [];
	let movedWords = 0;
	// Greedy longest-first: a long distinctive run claims its final twin before a
	// shorter run can steal it, and a consumed final run can't pair twice (so a
	// genuine retake — cut copy + surviving copy — keeps exactly one copy cut).
	for (const run of [...rawRuns].sort((a, b) => b.len - a.len)) {
		if (run.len < MIN_MOVE_RUN_WORDS) continue;
		const twins = finalRunsByKey.get(run.key);
		if (!twins || twins.length === 0) continue;
		const twin = twins.shift()!;
		for (let k = run.start; k < run.end; k++) rawKept[k] = true;
		movedWords += run.end - run.start;
		finalOnlyWords -= twin.len;
		movedSpans.push({
			startIndex: run.start,
			endIndex: run.end - 1,
			startSec: rawWords[run.start].start,
			endSec: rawWords[run.end - 1].end,
			text: rawWords
				.slice(run.start, run.end)
				.map((w) => w.text)
				.join(" "),
		});
	}

	// Derive spans from consecutive cut words.
	const truthCutSpans: TruthCutSpan[] = [];
	let spanStart = -1;
	for (let k = 0; k <= rawWords.length; k++) {
		const isCut = k < rawWords.length && !rawKept[k];
		if (isCut && spanStart === -1) spanStart = k;
		if (!isCut && spanStart !== -1) {
			truthCutSpans.push({
				startIndex: spanStart,
				endIndex: k - 1,
				startSec: rawWords[spanStart].start,
				endSec: rawWords[k - 1].end,
				text: rawWords
					.slice(spanStart, k)
					.map((w) => w.text)
					.join(" "),
			});
			spanStart = -1;
		}
	}

	return {
		rawKept,
		truthCutSpans,
		substitutionWords,
		finalOnlyWords,
		movedWords,
		movedSpans,
	};
}
