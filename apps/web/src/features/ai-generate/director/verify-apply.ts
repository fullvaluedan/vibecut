/**
 * Pure verify-pass wiring for the Director (U2). Two helpers bridge the recall
 * candidates the pipeline already holds and the index-keyed verdicts the hf-bridge
 * `planVerify` pass returns, WITHOUT any I/O or store coupling:
 *
 *  - `collectVerifyCandidates` reads the post-structural-fold op list and builds the
 *    `VerifyCandidate` list the verify call judges: one candidate per recall row
 *    (category `retake` or `structural`), IN OP ORDER, carrying the covered transcript
 *    text plus its own reference anchors (GLOBAL word indices for a retake row, line ids
 *    for a structural row) so a tighten is expressible for both kinds.
 *  - `applyVerifyVerdicts` maps those verdicts back onto the SAME op list: reject removes
 *    exactly the candidate's op, tighten overwrites only its seconds with the resolved
 *    inner span (every other field survives), keep / no-verdict pass through untouched,
 *    and a non-candidate op is NEVER touched.
 *
 * The two helpers share ONE candidate predicate (`isVerifyCandidateOp`) so the filter
 * can never drift between collection and application. Application walks the ops once in
 * lockstep with the candidates list (candidate N is the N-th candidate-category op), so
 * the verdict-to-op pairing is index-stable without ever re-filtering into a separate
 * array. Pure + wasm-free -> unit-tested.
 */

import type {
	DirectorOp,
	RedundancyLine,
	RetakeWord,
	VerifyCandidate,
	VerifyJoinVerdict,
	VerifyVerdict,
} from "@framecut/hf-bridge";

/** A recall row the verify pass judges: the two OFFERED-only categories the recall
 * passes emit. The SINGLE source of truth for what counts as a candidate, shared by
 * both helpers so collection and application can never filter differently. */
function isVerifyCandidateOp(op: DirectorOp): boolean {
	return op.category === "retake" || op.category === "structural";
}

/**
 * Build the `VerifyCandidate` list from the post-fold op list. Filters the recall rows
 * (category `retake`/`structural`) IN OP ORDER, so candidate index N is the N-th such op
 * in `ops`. Each candidate carries:
 *  - `coveredText`: the transcript words overlapping the span (what removing it deletes),
 *  - retake rows: the GLOBAL word-index range of the words overlapping the span
 *    (`startWord`..`endWord`), the anchors a tighten narrows through,
 *  - structural rows: the line-id range of the catalog lines overlapping the span
 *    (`startLineId`..`endLineId`).
 * A row with no overlapping words/lines simply omits those anchors (it can still be
 * kept or rejected, just not tightened). Pure.
 */
export function collectVerifyCandidates({
	ops,
	words,
	lines,
}: {
	ops: readonly DirectorOp[];
	words: readonly RetakeWord[];
	lines: readonly RedundancyLine[];
}): VerifyCandidate[] {
	const candidates: VerifyCandidate[] = [];
	for (const op of ops) {
		if (!isVerifyCandidateOp(op)) continue;
		// A word/line overlaps the span when the two intervals intersect (half-open).
		const overlapWordIdx: number[] = [];
		for (let i = 0; i < words.length; i++) {
			const w = words[i];
			if (w.startSec < op.endSec && op.startSec < w.endSec) overlapWordIdx.push(i);
		}
		const coveredText = overlapWordIdx.map((i) => words[i].text).join(" ");
		const candidate: VerifyCandidate = {
			// Narrowed to "retake" | "structural" by isVerifyCandidateOp above.
			category: op.category as VerifyCandidate["category"],
			startSec: op.startSec,
			endSec: op.endSec,
			reason: op.reason,
			confidence: op.confidence,
			coveredText,
		};
		if (op.category === "retake") {
			if (overlapWordIdx.length > 0) {
				candidate.startWord = overlapWordIdx[0];
				candidate.endWord = overlapWordIdx[overlapWordIdx.length - 1];
			}
		} else {
			const overlapLines = lines.filter(
				(l) => l.startSec < op.endSec && op.startSec < l.endSec,
			);
			if (overlapLines.length > 0) {
				candidate.startLineId = overlapLines[0].lineId;
				candidate.endLineId = overlapLines[overlapLines.length - 1].lineId;
			}
		}
		candidates.push(candidate);
	}
	return candidates;
}

/**
 * Apply index-keyed verdicts to the op list. Walks `ops` once, pairing each candidate-
 * category op with the next slot in the candidates list (candidate N = the N-th such op),
 * so the verdict-to-op mapping is index-stable and never re-filters into a separate
 * array. Per verdict:
 *  - `reject`: the op is removed (exactly this candidate's row, nothing else),
 *  - `tighten`: ONLY startSec/endSec are overwritten with the verdict's resolved inner
 *    span (already resolved to seconds inside hf-bridge); id, category, reason,
 *    confidence, defaultAccept, and op kind all survive,
 *  - `keep` or no verdict: the op passes through unchanged.
 * A non-candidate op is copied through untouched. A verdict whose index has no matching
 * candidate (out of range / never reached) is ignored. Pure.
 */
export function applyVerifyVerdicts({
	ops,
	candidates,
	verdicts,
}: {
	ops: readonly DirectorOp[];
	candidates: readonly VerifyCandidate[];
	verdicts: readonly VerifyVerdict[];
}): DirectorOp[] {
	const byIndex = new Map<number, VerifyVerdict>();
	for (const v of verdicts) {
		if (!byIndex.has(v.index)) byIndex.set(v.index, v); // first well-formed one wins
	}
	const out: DirectorOp[] = [];
	let ci = 0; // walks in lockstep with the candidates list (collectVerifyCandidates order)
	for (const op of ops) {
		if (!isVerifyCandidateOp(op)) {
			out.push(op); // non-candidate op: never touched
			continue;
		}
		const index = ci;
		ci++;
		// Defensive: a candidates list shorter than the candidate ops means the caller
		// paired mismatched arrays; leave the extra op unverified rather than mis-index.
		if (index >= candidates.length) {
			out.push(op);
			continue;
		}
		const verdict = byIndex.get(index);
		if (!verdict || verdict.verdict === "keep") {
			out.push(op); // keep or no verdict: unchanged
			continue;
		}
		if (verdict.verdict === "reject") {
			continue; // remove exactly this candidate's op
		}
		// tighten: overwrite ONLY the seconds with the resolved inner span (KTD1). The
		// sanitizer guarantees a proper inner shrink, so the finite guard is belt-and-braces.
		if (
			Number.isFinite(verdict.startSec) &&
			Number.isFinite(verdict.endSec) &&
			(verdict.endSec as number) > (verdict.startSec as number)
		) {
			out.push({ ...op, startSec: verdict.startSec as number, endSec: verdict.endSec as number });
		} else {
			out.push(op);
		}
	}
	return out;
}

/** A "swallow" join verdict below this confidence leaves the row OFFERED: the
 * final read must be SURE before a fragment auto-swallows (round 12 U2/R3 - the
 * census found 3 of 18 fragments were deliberate keeps). */
export const JOIN_SWALLOW_MIN_CONFIDENCE = 0.7;

/**
 * Apply the final read's id-keyed join verdicts to a join-op list (round 12
 * U2/R3). A "swallow" verdict at/above JOIN_SWALLOW_MIN_CONFIDENCE flips its
 * OFFERED join op to `defaultAccept: true` (promoted to checked); a "keep"
 * verdict, a low-confidence swallow, or no verdict leaves the row OFFERED; an id
 * matching no join op is ignored; a non-join op (or an already-accepted join,
 * e.g. an AUTO sliver) is NEVER touched. Malformed verdict entries (wrong types,
 * missing confidence) promote nothing - the sanitizer upstream already drops
 * them, these guards are belt-and-braces so a degraded response can only ever
 * fail toward OFFERED. Pure.
 */
export function applyJoinVerdicts({
	ops,
	verdicts,
}: {
	ops: readonly DirectorOp[];
	verdicts: readonly VerifyJoinVerdict[];
}): DirectorOp[] {
	const promote = new Set<string>();
	for (const v of verdicts) {
		if (typeof v !== "object" || v === null) continue;
		if (typeof v.id !== "string") continue;
		if (v.verdict !== "swallow") continue;
		if (
			typeof v.confidence !== "number" ||
			!Number.isFinite(v.confidence) ||
			v.confidence < JOIN_SWALLOW_MIN_CONFIDENCE
		)
			continue;
		promote.add(v.id);
	}
	if (promote.size === 0) return [...ops];
	return ops.map((op) =>
		op.category === "join" && op.defaultAccept === false && promote.has(op.id)
			? { ...op, defaultAccept: true }
			: op,
	);
}
