/**
 * Fragmentation guard (round 14 U2 / P3, duty c). Dan's standing complaint about
 * the Director is "randomly tiny cuts that aren't helpful": after every detector,
 * LLM pass, snap, and trim has run, the FINAL op list can still carry a lone
 * sub-half-second removal chopping a word or two out of the middle of otherwise
 * kept speech - a stutter, not an edit. No upstream pass sees that, because each
 * one judges its own cut in isolation; only a pre-pass over the WHOLE assembled op
 * list can tell an isolated micro-cut apart from a micro-cut that is doing real
 * work as the sliver-swallowing companion of a bigger cut beside it.
 *
 * This module is the DETERMINISTIC half of that pre-pass (the LLM half - texture
 * judgment on the genuinely borderline ones - rides the verify v7 harm review).
 * It classifies each default-accepted micro removal into exactly one verdict:
 *
 *  - COMPANION: its contiguous accepted-removal region already reaches a real
 *    cut's length, so it is part of a real edit, not a stray chop. Left untouched.
 *  - MERGE: it sits within a BREATH of a bigger cut and the tiny keep-gap between
 *    them holds NO kept word, so bridging that gap deletes only silence and turns
 *    a chop-breath-chop stutter into one clean cut. The op's span is EXTENDED to
 *    abut the neighbor. (Wordless-only: bridging a gap that holds a word would
 *    destroy kept speech, which the ADDENDUM-12 mandate forbids.)
 *  - DEMOTE: it is ISOLATED (no bigger cut within a breath) and WORD-BEARING - a
 *    random tiny chop through live speech. Demoted to OFFERED-off (defaultAccept
 *    false) so a select-all no longer auto-applies it; NEVER deleted (a review row
 *    is cheap, a destroyed kept line is not).
 *  - BORDERLINE: within a breath of a bigger cut but the keep-gap holds a word, so
 *    it can neither be safely merged nor confidently called a stray chop. Handed to
 *    the LLM final read for texture judgment rather than silently dropped; the
 *    deterministic guard leaves it default-accepted (the degrade path when the LLM
 *    is absent or fails).
 *  - LEAVE: everything else (not a micro-cut, an owned/trusted category, or an
 *    isolated WORDLESS micro trimming pure silence, which is harmless).
 *
 * The precise deterministic detectors (duplicate word, filler, noise fragment,
 * dead air) already emit sub-half-second cuts BY DESIGN and are trusted, so their
 * categories are exempt; join-texture owns its own slivers, so "join" is exempt
 * too. Everything the guard touches keeps every other field and its stable id, so
 * the review dock, the ledger, and the apply path read it exactly as before.
 *
 * Pure + wasm-free -> bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import {
	isMidpointContained,
	mergeAcceptedRemovalSpans,
	type WordTiming,
} from "./cut-utils";

/**
 * A default-accepted removal SHORTER than this is a "micro-cut" the guard judges.
 * Matches join-texture's SILENT_SLIVER_MAX_SEC intuition (half a second is the
 * boundary between a splice artifact and a deliberate beat). Above it a removal is
 * a real cut and the guard never touches it.
 */
export const MICRO_CUT_MAX_SEC = 0.5;

/**
 * A micro-cut whose CONTIGUOUS accepted-removal region reaches this length is a
 * sliver-swallowing companion of a real cut (it abuts, or nearly abuts, a bigger
 * removal, and together they read as one edit), so the guard leaves it alone. Also
 * the bar a NEIGHBOR region must clear to count as a "bigger cut" the guard would
 * merge toward. Equal to MICRO_CUT_MAX_SEC by construction: the same length that
 * makes a lone removal "not a micro-cut" makes a contiguous region "a real cut".
 */
export const COMPANION_REGION_MIN_SEC = 0.5;

/**
 * A keep-gap between an isolated micro-cut and an adjacent bigger cut up to this
 * long reads as a stutter (a chop, a breath, a chop). When that gap holds no kept
 * word it is bridged (MERGE). Deliberately tighter than join-texture's 0.5s sliver
 * bar: the guard only ever deletes silence here, so it stays well inside the
 * conservative floor and can never clip a deliberately-kept emphasis beat.
 */
export const BREATH_MERGE_MAX_GAP_SEC = 0.25;

/**
 * Categories whose sub-half-second cuts are precise BY DESIGN - the deterministic
 * disfluency detectors. These are the HELPFUL tiny cuts (a doubled word, an "um",
 * a mouth click, a dead-air trim), so the guard never second-guesses them; only
 * the imprecise sources (raw LLM plan cuts, redundancy, repeat, pacing, context)
 * can strand a "random tiny cut". "join" is owned by the join-texture layer and is
 * exempt for the same reason.
 */
export const GUARD_EXEMPT_CATEGORIES: ReadonlySet<string> = new Set([
	"duplicate",
	"filler",
	"noise",
	"deadair",
	"join",
]);

/** Floating-point slack for seam comparisons (well below one video frame). */
const EPS = 1e-9;

/** The verdict the guard reaches for one micro-cut (see the module header). */
export type FragmentationVerdict = "merge" | "demote" | "borderline";

/** One non-trivial guard verdict, keyed back to its op by `id`. COMPANION/LEAVE
 * ops carry no action (the op passes through untouched), so they never appear. */
export interface FragmentationAction {
	id: string;
	verdict: FragmentationVerdict;
	/** MERGE only: the bridged span (the op extended to abut the neighbor cut). */
	mergedStartSec?: number;
	mergedEndSec?: number;
}

export interface FragmentationClassification {
	/** Every micro-cut that reached a merge/demote/borderline verdict, in op order. */
	actions: FragmentationAction[];
	/** The ids the LLM final read should texture-judge (verdict "borderline"). */
	borderlineIds: string[];
}

/** True when at least one word MIDPOINT falls inside [startSec, endSec). */
function spanHoldsWord(
	startSec: number,
	endSec: number,
	words: readonly WordTiming[],
): boolean {
	return words.some((w) =>
		isMidpointContained({
			spanStart: w.start,
			spanEnd: w.end,
			containerStart: startSec,
			containerEnd: endSec,
		}),
	);
}

/**
 * Classify every default-accepted micro removal in `ops` (see the module header
 * for the five verdicts). `ops` is the FINAL merged op list; `words` are the
 * transcript words in timeline seconds. Contiguous accepted-removal regions are
 * merged once up front so companion detection and neighbor-distance both read the
 * same picture the assembled result reads. Pure - the caller applies the actions.
 */
export function classifyFragmentation({
	ops,
	words,
}: {
	ops: readonly DirectorOp[];
	words: readonly WordTiming[];
}): FragmentationClassification {
	// Contiguous accepted-removal regions (cut/take_select, defaultAccept !== false),
	// sorted, overlaps unioned. Shared with join-texture / assembled-transcript via
	// cut-utils so the guard can never drift on which regions the video actually
	// removes. The regions that reach COMPANION_REGION_MIN_SEC are the "real cuts".
	const regions = mergeAcceptedRemovalSpans(ops);
	const realRegions = regions.filter(
		(r) => r.endSec - r.startSec >= COMPANION_REGION_MIN_SEC,
	);

	const actions: FragmentationAction[] = [];
	const borderlineIds: string[] = [];

	for (const op of ops) {
		if (op.op !== "cut" && op.op !== "take_select") continue;
		if (op.defaultAccept === false) continue; // only default-accepted rows
		const dur = op.endSec - op.startSec;
		if (!(dur > 0) || dur >= MICRO_CUT_MAX_SEC) continue; // not a micro-cut
		if (GUARD_EXEMPT_CATEGORIES.has(op.category ?? "")) continue; // trusted/owned

		// The contiguous region this micro-cut lives in (found by its own span; an
		// isolated micro-cut's region is essentially its own span). A region that
		// reaches a real cut's length means the micro-cut abuts a bigger removal and
		// is a sliver-swallowing companion - not a stray chop, so leave it.
		const region =
			regions.find(
				(r) => op.startSec >= r.startSec - EPS && op.endSec <= r.endSec + EPS,
			) ?? { startSec: op.startSec, endSec: op.endSec };
		if (region.endSec - region.startSec >= COMPANION_REGION_MIN_SEC) continue;

		// Isolated micro-cut. Measure the keep-gap to the nearest real cut on each
		// side (Infinity when there is none on that side).
		let leftReal: { startSec: number; endSec: number } | undefined;
		for (const r of realRegions) {
			if (r.endSec <= region.startSec + EPS) leftReal = r; // last one before it
		}
		const rightReal = realRegions.find((r) => r.startSec >= region.endSec - EPS);
		const gapLeft = leftReal ? region.startSec - leftReal.endSec : Infinity;
		const gapRight = rightReal ? rightReal.startSec - region.endSec : Infinity;

		// MERGE: bridge toward the nearer real cut when that keep-gap is within a
		// breath AND holds no kept word (bridging deletes only silence). Pick the
		// smaller safe gap; extend the op to abut that neighbor.
		const leftMergeable =
			gapLeft <= BREATH_MERGE_MAX_GAP_SEC &&
			leftReal !== undefined &&
			!spanHoldsWord(leftReal.endSec, region.startSec, words);
		const rightMergeable =
			gapRight <= BREATH_MERGE_MAX_GAP_SEC &&
			rightReal !== undefined &&
			!spanHoldsWord(region.endSec, rightReal.startSec, words);
		if (leftMergeable && (!rightMergeable || gapLeft <= gapRight)) {
			actions.push({
				id: op.id,
				verdict: "merge",
				mergedStartSec: (leftReal as { endSec: number }).endSec,
				mergedEndSec: op.endSec,
			});
			continue;
		}
		if (rightMergeable) {
			actions.push({
				id: op.id,
				verdict: "merge",
				mergedStartSec: op.startSec,
				mergedEndSec: (rightReal as { startSec: number }).startSec,
			});
			continue;
		}

		// No safe bridge. A real cut still WITHIN a breath (but the gap holds a word,
		// so it cannot be bridged) is a texture call the deterministic guard should
		// not make alone -> BORDERLINE, handed to the LLM final read.
		const nearRealCut =
			gapLeft <= BREATH_MERGE_MAX_GAP_SEC || gapRight <= BREATH_MERGE_MAX_GAP_SEC;
		if (nearRealCut) {
			actions.push({ id: op.id, verdict: "borderline" });
			borderlineIds.push(op.id);
			continue;
		}

		// Fully isolated (no real cut within a breath). A WORD-BEARING one is the
		// "random tiny cut" chopping live speech -> DEMOTE to offered-off. A WORDLESS
		// one only trims a scrap of silence and is harmless either way -> leave.
		if (spanHoldsWord(op.startSec, op.endSec, words)) {
			actions.push({ id: op.id, verdict: "demote" });
		}
	}

	return { actions, borderlineIds };
}

/** Trim a reason to the DirectorOp 240-char budget the pipeline uses everywhere. */
function cap(reason: string): string {
	return reason.slice(0, 240);
}

/**
 * Apply a fragmentation classification to `ops` (see the module header). MERGE
 * extends the op's span to the bridged bounds; DEMOTE flips it to offered-off and
 * annotates the reason; BORDERLINE and every untouched op pass through unchanged.
 * Every op keeps its stable id and category. Returns the rewritten list plus the
 * per-verdict id sets (the caller feeds the counts to notices and the ledger reads
 * the demoted rows as offered rows without any new field). Pure.
 */
export function applyFragmentationGuard({
	ops,
	words,
}: {
	ops: readonly DirectorOp[];
	words: readonly WordTiming[];
}): {
	operations: DirectorOp[];
	mergedIds: string[];
	demotedIds: string[];
	borderlineIds: string[];
} {
	const { actions, borderlineIds } = classifyFragmentation({ ops, words });
	const byId = new Map(actions.map((a) => [a.id, a]));
	const mergedIds: string[] = [];
	const demotedIds: string[] = [];

	const operations = ops.map((op) => {
		const action = byId.get(op.id);
		if (!action) return op;
		if (action.verdict === "merge") {
			mergedIds.push(op.id);
			const base = op.reason ?? "";
			return {
				...op,
				startSec: action.mergedStartSec ?? op.startSec,
				endSec: action.mergedEndSec ?? op.endSec,
				reason: cap(
					`${base} (fragmentation guard: extended to bridge a stutter gap into the neighboring cut)`,
				),
			};
		}
		if (action.verdict === "demote") {
			demotedIds.push(op.id);
			const base = op.reason ?? "";
			return {
				...op,
				defaultAccept: false,
				reason: cap(
					`${base} (fragmentation guard: isolated micro-cut, offered for review rather than auto-applied)`,
				),
			};
		}
		return op; // borderline: left for the LLM final read, span/accept untouched
	});

	return { operations, mergedIds, demotedIds, borderlineIds };
}
