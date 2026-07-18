/**
 * Golden-footage eval: per-op attribution for ESSENTIAL WORDS LOST (score.ts).
 * The scorer answers "how much kept dialog would our cuts destroy" but not
 * WHICH pass is responsible, so a stable-high number (e.g. hermes-cloud's
 * AUTO essLost, docs/2026-07-11-director-eval-findings.md ADDENDUM 8) can't be
 * traced to a category or a single op. This module re-derives the SAME
 * word-level false-cut set `scoreCutProposals` computes (identical
 * truth/proposed flags via `computeWordCutFlags`, so the duplicate-word
 * reconciliation swap can never drift between the two) and maps every
 * destroyed word back to the op(s) whose cut span covers it.
 *
 * Overlap rule: when two ops' spans both cover a destroyed word (overlapping
 * cuts), the word is attributed to EACH covering op, so `byCategory` totals
 * and `byOp` word counts can double-count a word across categories/ops. This
 * is a deliberate choice over "earliest-starting op wins": for a diagnostic
 * hunt every op that touched the destroyed word is relevant (a second
 * offending pass hiding behind the first is exactly the kind of thing this
 * module exists to surface), and a single-attribution rule would silently
 * drop it. Consequence: `sum(byCategory counts)` and `sum(byOp.wordCount)`
 * can each exceed `essentialWordsLost` when spans overlap; they are equal to
 * it whenever no two covering ops share a word.
 */
import type { DirectorOp } from "@framecut/hf-bridge";
import type { TranscriptionWord } from "@/transcription/types";
import { isMidpointContained } from "../cut-utils";
import type { TruthCutSpan } from "./align";
import { computeWordCutFlags, isModeOp, type ProposalMode } from "./score";

export interface EssentialLossOp {
	id: string;
	op: DirectorOp["op"];
	category?: DirectorOp["category"];
	reason: string;
	startSec: number;
	endSec: number;
	/** Destroyed (essential-lost) word count attributed to this op. */
	wordCount: number;
	/** The destroyed words attributed to this op, in raw-transcript order. */
	words: string;
}

export interface EssentialLossAttribution {
	/** Essential-lost word count by category (raw LLM ops with no category key
	 * on the op kind instead, e.g. "cut"), descending by count, ties broken
	 * alphabetically for stable output. A word covered by two ops in different
	 * categories counts once per category (see module doc). */
	byCategory: [string, number][];
	/** Every op that destroyed >= 1 word, descending by wordCount, ties broken
	 * by startSec. */
	byOp: EssentialLossOp[];
}

const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;

/**
 * Attribute every essential-word-lost (kept word our proposals would destroy)
 * to the op(s) whose cut span covers it, for one proposal mode (`auto` or
 * `offered`). Pure: no I/O, safe to unit test directly.
 */
export function attributeEssentialWordsLost({
	rawWords,
	truthCutSpans,
	operations,
	mode,
}: {
	rawWords: TranscriptionWord[];
	truthCutSpans: TruthCutSpan[];
	operations: readonly DirectorOp[];
	mode: ProposalMode;
}): EssentialLossAttribution {
	const modeOps = operations.filter((op) => isModeOp(op, mode));
	const proposedSpans = modeOps.map((op) => ({
		startSec: op.startSec,
		endSec: op.endSec,
	}));

	// Identical false-cut set to scoreCutProposals's `essentialWordsLost` (fp),
	// computed against the SAME mode-filtered span set.
	const { truthCut, proposedCut } = computeWordCutFlags({
		rawWords,
		truthCutSpans,
		proposedSpans,
	});

	const wordCounts = new Map<string, number>(); // op.id -> destroyed word count
	const wordText = new Map<string, string[]>(); // op.id -> destroyed words, in order
	const categoryCounts = new Map<string, number>();

	for (let i = 0; i < rawWords.length; i++) {
		if (truthCut[i] || !proposedCut[i]) continue; // not an essential-lost word
		const word = rawWords[i];
		for (const op of modeOps) {
			if (
				!isMidpointContained({
					spanStart: word.start,
					spanEnd: word.end,
					containerStart: op.startSec,
					containerEnd: op.endSec,
					inclusiveEnd: true,
				})
			) {
				continue;
			}
			wordCounts.set(op.id, (wordCounts.get(op.id) ?? 0) + 1);
			const words = wordText.get(op.id) ?? [];
			words.push(word.text);
			wordText.set(op.id, words);
			const categoryKey = op.category ?? op.op;
			categoryCounts.set(categoryKey, (categoryCounts.get(categoryKey) ?? 0) + 1);
		}
	}

	const byOp: EssentialLossOp[] = modeOps
		.filter((op) => (wordCounts.get(op.id) ?? 0) > 0)
		.map((op) => ({
			id: op.id,
			op: op.op,
			category: op.category,
			reason: op.reason,
			startSec: op.startSec,
			endSec: op.endSec,
			wordCount: wordCounts.get(op.id) ?? 0,
			words: (wordText.get(op.id) ?? []).join(" "),
		}))
		.sort((a, b) => b.wordCount - a.wordCount || a.startSec - b.startSec);

	const byCategory: [string, number][] = [...categoryCounts.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);

	return { byCategory, byOp };
}

/** Render the `essLost by category` summary line, or `null` when there is
 * nothing to attribute (essentialWordsLost === 0 or no covering ops). */
export function formatByCategoryLine(
	attribution: EssentialLossAttribution,
): string | null {
	if (attribution.byCategory.length === 0) return null;
	const parts = attribution.byCategory.map(([k, v]) => `${k}:${v}`).join("  ");
	return `essLost by category    ${parts}`;
}

/** Render the "top offending ops" block (max `limit` ops), or `null` when
 * there is nothing to attribute. */
export function formatTopOffendingOps(
	attribution: EssentialLossAttribution,
	limit = 8,
): string[] | null {
	if (attribution.byOp.length === 0) return null;
	const secs = (s: number) => {
		const m = Math.floor(s / 60);
		return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
	};
	const lines: string[] = [`-- top offending ops (essential words lost) --`];
	for (const op of attribution.byOp.slice(0, limit)) {
		const category = op.category ?? op.op;
		lines.push(
			`  [${secs(op.startSec)}-${secs(op.endSec)}] ${category}  ${op.wordCount} word(s) destroyed  reason: "${truncate(op.reason, 60)}"`,
		);
		lines.push(`      destroyed: "${truncate(op.words, 50)}"`);
	}
	if (attribution.byOp.length > limit) {
		lines.push(`  ...and ${attribution.byOp.length - limit} more offending op(s)`);
	}
	return lines;
}
