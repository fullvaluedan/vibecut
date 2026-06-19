/**
 * Pure lexical text-similarity primitives for the Director's take/redundancy
 * layer (U1). Wasm-free + dependency-free so it stays bun-testable.
 *
 * The honest job of this module is NEAR-VERBATIM matching — a line restarted
 * far apart in one recording, or recorded again in a separate take clip. It
 * compares the FULL normalized token stream (function words included, only pure
 * fillers dropped), so a near-verbatim restatement scores high while a true
 * PARAPHRASE (same point, different words) scores low by construction. Catching
 * genuine paraphrase is the enriched-LLM channel's job (see the cut prompt), not
 * this layer's — embeddings are the documented escalation if that proves short.
 *
 * Similarity blends Jaccard (set overlap) and cosine (bag-of-words angle); both
 * are order-invariant, so a reordered restatement still matches. Content-token
 * extraction (stopwords dropped) is exported separately for cheap pre-bucketing
 * in the clustering pass — it is NOT used for the similarity score itself.
 */

import { normalizeWord } from "./cut-utils";

/** Two spans at/above this score are "the same line" — a take/repeat match. */
export const HIGH_SIMILAR = 0.8;
/** Loosely related; used as a soft floor, not a merge trigger. */
export const SIMILAR = 0.6;

/**
 * Pure hesitation tokens dropped before comparison so "um so we ship" and "so we
 * ship" match. Deliberately tiny — broader discourse/function words are KEPT
 * because near-verbatim recall depends on them (dropping them collapses short
 * sentences and tanks recall, the opposite of this layer's purpose).
 */
const FILLER_TOKENS = new Set([
	"um",
	"umm",
	"uh",
	"uhh",
	"uhm",
	"er",
	"err",
	"erm",
	"ah",
	"eh",
	"hmm",
	"hm",
	"mm",
	"mhm",
]);

/**
 * Function words that carry no topic signal. Used ONLY by `contentTokens` for
 * pre-bucketing candidate pairs cheaply — never for the similarity score (where
 * stopwords are load-bearing for near-verbatim matching).
 */
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"so",
	"of",
	"to",
	"in",
	"on",
	"at",
	"for",
	"is",
	"it",
	"its",
	"we",
	"i",
	"you",
	"he",
	"she",
	"they",
	"this",
	"that",
	"these",
	"those",
	"be",
	"was",
	"are",
	"were",
	"as",
	"by",
	"with",
	"here",
	"there",
	"just",
	"now",
	"then",
]);

/** Normalize → drop empties + pure fillers. Stopwords are KEPT (see module doc). */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split(/\s+/)) {
		const norm = normalizeWord(raw);
		if (norm.length > 0 && !FILLER_TOKENS.has(norm)) {
			out.push(norm);
		}
	}
	return out;
}

/** Topic-bearing tokens (stopwords + fillers removed) for cheap pre-bucketing. */
export function contentTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const norm of tokenize(text)) {
		if (!STOPWORDS.has(norm)) {
			out.add(norm);
		}
	}
	return out;
}

/** |A ∩ B| / |A ∪ B| over the token SETS. 1 when both empty (degenerate). */
function jaccard({ a, b }: { a: readonly string[]; b: readonly string[] }): number {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size === 0 && setB.size === 0) return 1;
	let inter = 0;
	for (const t of setA) {
		if (setB.has(t)) inter++;
	}
	const union = setA.size + setB.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** Cosine over the term-count vectors (bag-of-words). */
function cosine({ a, b }: { a: readonly string[]; b: readonly string[] }): number {
	const countsA = new Map<string, number>();
	const countsB = new Map<string, number>();
	for (const t of a) countsA.set(t, (countsA.get(t) ?? 0) + 1);
	for (const t of b) countsB.set(t, (countsB.get(t) ?? 0) + 1);

	let dot = 0;
	for (const [t, ca] of countsA) {
		const cb = countsB.get(t);
		if (cb !== undefined) dot += ca * cb;
	}
	let magA = 0;
	for (const ca of countsA.values()) magA += ca * ca;
	let magB = 0;
	for (const cb of countsB.values()) magB += cb * cb;
	const denom = Math.sqrt(magA) * Math.sqrt(magB);
	return denom === 0 ? 0 : dot / denom;
}

/**
 * Lexical similarity of two strings in [0,1]. 1.0 for identical (or reordered)
 * token streams; ~0 when they share no words. Blends Jaccard and cosine, leaning
 * on cosine (0.3/0.7): cosine forgives one-sided EXTRAS (a restatement with a few
 * trailing words is still the same line), while Jaccard's union penalty keeps two
 * short, only-partly-overlapping sentences below the merge threshold. Empty-vs-
 * nonempty is 0 (no false match against a blank line).
 */
export function similarity({ a, b }: { a: string; b: string }): number {
	const tokensA = tokenize(a);
	const tokensB = tokenize(b);
	if (tokensA.length === 0 || tokensB.length === 0) {
		// Both empty → identical-degenerate; one empty → no basis to match.
		return tokensA.length === 0 && tokensB.length === 0 ? 1 : 0;
	}
	return (
		0.3 * jaccard({ a: tokensA, b: tokensB }) + 0.7 * cosine({ a: tokensA, b: tokensB })
	);
}

/** One candidate's index + its similarity to the target. */
export interface SimilarityMatch {
	index: number;
	score: number;
}

/**
 * Best-scoring candidate for `target`. Returns the highest-similarity match (and
 * its index), or null when there are no candidates. Ties resolve to the earliest
 * candidate. Callers apply their own threshold (e.g. HIGH_SIMILAR) to the score.
 */
export function mostSimilar({
	target,
	candidates,
}: {
	target: string;
	candidates: readonly string[];
}): SimilarityMatch | null {
	let best: SimilarityMatch | null = null;
	for (let i = 0; i < candidates.length; i++) {
		const score = similarity({ a: target, b: candidates[i] });
		if (best === null || score > best.score) {
			best = { index: i, score };
		}
	}
	return best;
}
