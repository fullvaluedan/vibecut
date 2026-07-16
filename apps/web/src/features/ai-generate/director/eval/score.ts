/**
 * Golden-footage eval, stage 2: score the Director's proposed cut spans
 * against the ground-truth labels derived by align.ts. Word-level confusion
 * matrix, so a proposal that clips half a sentence scores exactly as bad as
 * it sounds, plus the two span lists that make failures debuggable: what Dan
 * cut that we missed, and what Dan kept that we would have destroyed.
 */
import type { DirectorOp } from "@framecut/hf-bridge";
import type { TranscriptionWord } from "@/transcription/types";
import type { TruthCutSpan } from "./align";

export interface ProposedCutSpan {
	/** Seconds on the raw timeline. */
	startSec: number;
	endSec: number;
	/** Optional provenance for debugging ("filler", "llm-redundancy", ...). */
	source?: string;
}

export interface ScoredSpan {
	startSec: number;
	endSec: number;
	text: string;
}

export interface Scorecard {
	/** Of the words Dan actually cut, the fraction we proposed cutting. */
	cutRecall: number;
	/** Of the words we proposed cutting, the fraction Dan actually cut. */
	cutPrecision: number;
	/** Words Dan KEPT that our proposals would have destroyed — the
	 * "essential dialog cut off" number. Zero is the bar. */
	essentialWordsLost: number;
	/** Words Dan cut that we failed to propose — surviving repeats/mistakes. */
	missedCutWords: number;
	/** Kept-output match rate: F1 of the KEPT class over per-raw-word masks
	 * (truth-kept vs draft-kept). How much of Dan's final edit the draft
	 * reproduces. Kept-class TP = words both keep, kept-FP = missed-cut words
	 * (truth cut, draft keeps), kept-FN = essential words lost (truth keeps,
	 * draft cuts). An empty matrix guards to 1.0 (nothing to disagree on),
	 * matching cutRecall/cutPrecision; never NaN. */
	matchRate: number;
	/** `matchRate` with substitution/moved (label-noise) words excluded from the
	 * matrix entirely (the ceiling that stays meaningful when re-recorded
	 * wording makes the raw number unreachable). */
	matchRateAdjusted: number;
	/** Adjusted match rate recomputed with every false-cut (essential words lost)
	 * treated as kept-correct: the span-discipline ceiling. */
	matchRateFpZeroed: number;
	/** Adjusted match rate recomputed with every missed-cut treated as
	 * cut-correct: the recall ceiling. */
	matchRateFnZeroed: number;
	counts: {
		rawWords: number;
		truthCutWords: number;
		proposedCutWords: number;
		truePositives: number;
	};
	/** Consecutive runs Dan cut that we missed (the surviving mistakes). */
	missedSpans: ScoredSpan[];
	/** Consecutive KEPT runs our proposals would cut (the destroyed dialog). */
	falseCutSpans: ScoredSpan[];
	/** Mean absolute boundary offset (sec) for truth spans we did engage. */
	meanBoundaryErrorSec: number | null;
}

/** A word counts as proposed-cut when its midpoint falls inside a span —
 * midpoint, not overlap, so a proposal grazing a word's edge by 10ms doesn't
 * count as destroying it (that is boundary error, measured separately). */
function isWordInSpans(
	word: TranscriptionWord,
	spans: ProposedCutSpan[],
): boolean {
	const mid = (word.start + word.end) / 2;
	return spans.some((s) => mid >= s.startSec && mid <= s.endSec);
}

function collectRuns(
	rawWords: TranscriptionWord[],
	flags: boolean[],
): ScoredSpan[] {
	const runs: ScoredSpan[] = [];
	let start = -1;
	for (let i = 0; i <= rawWords.length; i++) {
		const on = i < rawWords.length && flags[i];
		if (on && start === -1) start = i;
		if (!on && start !== -1) {
			runs.push({
				startSec: rawWords[start].start,
				endSec: rawWords[i - 1].end,
				text: rawWords
					.slice(start, i)
					.map((w) => w.text)
					.join(" "),
			});
			start = -1;
		}
	}
	return runs;
}

export function scoreCutProposals({
	rawWords,
	truthCutSpans,
	proposedSpans,
	noiseSpans,
}: {
	rawWords: TranscriptionWord[];
	truthCutSpans: TruthCutSpan[];
	proposedSpans: ProposedCutSpan[];
	/** Raw index runs excluded from the noise-adjusted match rate (substitution +
	 * moved words). Optional: absent means adjusted equals raw. */
	noiseSpans?: TruthCutSpan[];
}): Scorecard {
	const truthCut = new Array<boolean>(rawWords.length).fill(false);
	for (const span of truthCutSpans) {
		for (let i = span.startIndex; i <= span.endIndex; i++) truthCut[i] = true;
	}
	const proposedCut = rawWords.map((w) => isWordInSpans(w, proposedSpans));

	// Attribution reconciliation: when a duplicated word is cut ("the the"),
	// truth may label copy A while the proposal cuts copy B — identical text,
	// equivalent edit. Without this, one edit scores as BOTH a false cut and
	// a miss. Pair each would-be FP with a nearby (<=2 words) would-be FN of
	// identical normalized text and count both as hits.
	const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
	for (let i = 0; i < rawWords.length; i++) {
		if (truthCut[i] || !proposedCut[i]) continue; // not an FP candidate
		for (const j of [i - 1, i + 1, i - 2, i + 2]) {
			if (j < 0 || j >= rawWords.length) continue;
			if (!truthCut[j] || proposedCut[j]) continue; // not an FN candidate
			if (norm(rawWords[i].text) !== norm(rawWords[j].text)) continue;
			// Swap attribution: treat the proposal as having cut the truth copy.
			proposedCut[j] = true;
			proposedCut[i] = false;
			break;
		}
	}

	// Words excluded from the noise-adjusted kept-F1 (substitution + moved runs).
	const excluded = new Array<boolean>(rawWords.length).fill(false);
	for (const span of noiseSpans ?? []) {
		for (let i = span.startIndex; i <= span.endIndex; i++) {
			if (i >= 0 && i < rawWords.length) excluded[i] = true;
		}
	}

	let tp = 0;
	let fn = 0;
	let fp = 0;
	// Kept-class matrix: bothKeep = kept-TP; fn (missed cut) = kept-FP; fp
	// (essential lost) = kept-FN. Raw variant reuses fn/fp; the *Adj variants
	// drop the excluded (noise) words. Words both cut are kept-TN, uncounted.
	let bothKeep = 0;
	let bothKeepAdj = 0;
	let missedAdj = 0;
	let lostAdj = 0;
	const missedFlags = new Array<boolean>(rawWords.length).fill(false);
	const falseFlags = new Array<boolean>(rawWords.length).fill(false);
	for (let i = 0; i < rawWords.length; i++) {
		const included = !excluded[i];
		if (truthCut[i] && proposedCut[i]) tp++;
		else if (truthCut[i] && !proposedCut[i]) {
			fn++;
			missedFlags[i] = true;
			if (included) missedAdj++;
		} else if (!truthCut[i] && proposedCut[i]) {
			fp++;
			falseFlags[i] = true;
			if (included) lostAdj++;
		} else {
			bothKeep++;
			if (included) bothKeepAdj++;
		}
	}

	// Kept-class F1 with the empty-matrix guard (1.0, matching cutRecall/precision).
	const keptF1 = ({ tpK, fpK, fnK }: { tpK: number; fpK: number; fnK: number }): number => {
		const denom = 2 * tpK + fpK + fnK;
		return denom === 0 ? 1 : (2 * tpK) / denom;
	};

	// Boundary error over truth spans we engaged at all: distance between the
	// truth span's edges and the nearest proposed span's matching edges.
	const boundaryErrors: number[] = [];
	for (const span of truthCutSpans) {
		const overlapping = proposedSpans.filter(
			(p) => p.startSec < span.endSec && p.endSec > span.startSec,
		);
		if (overlapping.length === 0) continue;
		const startErr = Math.min(
			...overlapping.map((p) => Math.abs(p.startSec - span.startSec)),
		);
		const endErr = Math.min(
			...overlapping.map((p) => Math.abs(p.endSec - span.endSec)),
		);
		boundaryErrors.push((startErr + endErr) / 2);
	}

	const truthCutWords = tp + fn;
	const proposedCutWords = tp + fp;
	return {
		cutRecall: truthCutWords === 0 ? 1 : tp / truthCutWords,
		cutPrecision: proposedCutWords === 0 ? 1 : tp / proposedCutWords,
		essentialWordsLost: fp,
		missedCutWords: fn,
		matchRate: keptF1({ tpK: bothKeep, fpK: fn, fnK: fp }),
		matchRateAdjusted: keptF1({ tpK: bothKeepAdj, fpK: missedAdj, fnK: lostAdj }),
		// FP zeroed: false-cuts (kept-FN) become kept-correct (span-discipline ceiling).
		matchRateFpZeroed: keptF1({ tpK: bothKeepAdj + lostAdj, fpK: missedAdj, fnK: 0 }),
		// FN zeroed: missed-cuts (kept-FP) become cut-correct (recall ceiling).
		matchRateFnZeroed: keptF1({ tpK: bothKeepAdj, fpK: 0, fnK: lostAdj }),
		counts: {
			rawWords: rawWords.length,
			truthCutWords,
			proposedCutWords,
			truePositives: tp,
		},
		missedSpans: collectRuns(rawWords, missedFlags),
		falseCutSpans: collectRuns(rawWords, falseFlags),
		meanBoundaryErrorSec:
			boundaryErrors.length === 0
				? null
				: boundaryErrors.reduce((a, b) => a + b, 0) / boundaryErrors.length,
	};
}

/**
 * Two ways to read the same proposal set (R6/KTD4). `auto` is what a one-click
 * apply would EXECUTE — only the default-accepted removals. `offered` is every
 * cut/take_select row surfaced for review (default-accepted plus the opt-in
 * rows). Scoring both separates the automatic path's honesty from the review
 * burden and the recall ceiling.
 */
export type ProposalMode = "auto" | "offered";

/** Cut/take_select ops as scorable spans. In `auto` mode the opt-in rows
 * (`defaultAccept === false`) are dropped, since one-click apply skips them. */
export function toProposedCutSpans(
	ops: readonly DirectorOp[],
	mode: ProposalMode,
): ProposedCutSpan[] {
	return ops
		.filter(
			(op) =>
				(op.op === "cut" || op.op === "take_select") &&
				(mode === "offered" || op.defaultAccept !== false),
		)
		.map((op) => ({
			startSec: op.startSec,
			endSec: op.endSec,
			source: op.category ?? op.op,
		}));
}

/** Count proposed cut rows by provenance (category, else op kind). */
export function proposalsBySource(
	ops: readonly DirectorOp[],
	mode: ProposalMode,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const p of toProposedCutSpans(ops, mode)) {
		const key = p.source ?? "unknown";
		out[key] = (out[key] ?? 0) + 1;
	}
	return out;
}

export interface DualScorecard {
	auto: Scorecard;
	offered: Scorecard;
	autoBySource: Record<string, number>;
	offeredBySource: Record<string, number>;
}

/** Score a proposal set both ways (auto ⊆ offered) plus the per-source tables. */
export function scoreDual({
	rawWords,
	truthCutSpans,
	operations,
	noiseSpans,
}: {
	rawWords: TranscriptionWord[];
	truthCutSpans: TruthCutSpan[];
	operations: readonly DirectorOp[];
	/** Substitution + moved runs excluded from the noise-adjusted match rate. */
	noiseSpans?: TruthCutSpan[];
}): DualScorecard {
	return {
		auto: scoreCutProposals({
			rawWords,
			truthCutSpans,
			proposedSpans: toProposedCutSpans(operations, "auto"),
			noiseSpans,
		}),
		offered: scoreCutProposals({
			rawWords,
			truthCutSpans,
			proposedSpans: toProposedCutSpans(operations, "offered"),
			noiseSpans,
		}),
		autoBySource: proposalsBySource(operations, "auto"),
		offeredBySource: proposalsBySource(operations, "offered"),
	};
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const secs = (s: number) => {
	const m = Math.floor(s / 60);
	return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

/** Human-readable scorecard for the CLI runner. */
export function formatScorecard(name: string, sc: Scorecard): string {
	const lines: string[] = [
		`=== ${name} ===`,
		`cut recall     ${pct(sc.cutRecall)}  (caught ${sc.counts.truePositives}/${sc.counts.truthCutWords} words Dan cut)`,
		`cut precision  ${pct(sc.cutPrecision)}`,
		`kept-output match     ${pct(sc.matchRate)} raw / ${pct(sc.matchRateAdjusted)} adj  (ceilings: span-discipline ${pct(sc.matchRateFpZeroed)}, recall ${pct(sc.matchRateFnZeroed)})`,
		`ESSENTIAL WORDS LOST  ${sc.essentialWordsLost}  (kept words our cuts would destroy — bar is 0)`,
		`missed cut words      ${sc.missedCutWords}  (mistakes that would survive)`,
		sc.meanBoundaryErrorSec === null
			? `boundary error        n/a (no engaged spans)`
			: `boundary error        ${sc.meanBoundaryErrorSec.toFixed(2)}s mean`,
	];
	if (sc.falseCutSpans.length > 0) {
		lines.push(`-- dialog we would wrongly destroy --`);
		for (const s of sc.falseCutSpans.slice(0, 10)) {
			lines.push(`  [${secs(s.startSec)}-${secs(s.endSec)}] "${s.text}"`);
		}
		if (sc.falseCutSpans.length > 10)
			lines.push(`  ...and ${sc.falseCutSpans.length - 10} more`);
	}
	if (sc.missedSpans.length > 0) {
		lines.push(`-- mistakes that would survive --`);
		for (const s of sc.missedSpans.slice(0, 10)) {
			lines.push(`  [${secs(s.startSec)}-${secs(s.endSec)}] "${s.text}"`);
		}
		if (sc.missedSpans.length > 10)
			lines.push(`  ...and ${sc.missedSpans.length - 10} more`);
	}
	return lines.join("\n");
}
