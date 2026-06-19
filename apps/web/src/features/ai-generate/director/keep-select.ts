/**
 * Keep-span selection for the Director's Highlight mode (U6).
 *
 * Two modes:
 *  - THRESHOLD (no budget): keep every segment scoring ≥ keepThreshold, merged
 *    into contiguous spans.
 *  - BUDGET (a target length): a CONTIGUITY-BIASED greedy fill (KTD5). The handoff
 *    asked for the best *contiguous window*, not the loudest scattered fragments —
 *    pure greedy-by-score makes a jump-cut salad. So each run seeds at the highest
 *    unselected segment and GROWS by absorbing neighbors (to a minimum span length,
 *    then only high-scoring ones) before a new, separate run is allowed; the number
 *    of runs is capped (a max jump-cut bound). A minimum-one guarantee means a tiny
 *    budget still keeps the single best span (never empty → never "remove all").
 *
 * Pure + wasm-free so it is bun-testable; the orchestrator runs the score (U1) and
 * applies the complement (U5).
 */

import type { HighlightPreview } from "./highlight-preview";

/** Score at/above which a segment is kept in threshold mode. */
export const KEEP_THRESHOLD = 0.5;
/** A run grows to at least this many seconds before score-gating further growth. */
export const MIN_SPAN_SEC = 2;
/** Once past the min span, only neighbors at/above this score extend a run. */
export const EXTEND_THRESHOLD = 0.3;
/** Cap on the number of separate runs (the max jump-cut bound) in budget mode. */
export const MAX_RUNS = 6;

/** A segment in timeline seconds (only the bounds matter for selection). */
export interface KeepSelectSegment {
	start: number;
	end: number;
}

/** A kept span in timeline seconds. */
export interface KeepSpan {
	startSec: number;
	endSec: number;
}

interface SelectOptions {
	keepThreshold?: number;
	minSpanSec?: number;
	extendThreshold?: number;
	maxRuns?: number;
}

/** Group a selected index set into contiguous-index runs → timeline-ordered spans. */
function spansFromSelected({
	segments,
	selected,
}: {
	segments: readonly KeepSelectSegment[];
	selected: ReadonlySet<number>;
}): KeepSpan[] {
	const indices = [...selected].sort((a, b) => a - b);
	const spans: KeepSpan[] = [];
	for (let k = 0; k < indices.length; k++) {
		const runStart = indices[k];
		let runEnd = runStart;
		while (k + 1 < indices.length && indices[k + 1] === runEnd + 1) {
			runEnd = indices[++k];
		}
		spans.push({ startSec: segments[runStart].start, endSec: segments[runEnd].end });
	}
	return spans;
}

/**
 * Select keep spans. Without `budgetSec`, returns the above-threshold spans. With
 * `budgetSec`, returns a contiguity-biased set whose total is near the budget
 * (never empty for non-empty input). Spans are timeline-ordered and merged.
 */
export function selectKeepSpans({
	segments,
	importance,
	budgetSec,
	options,
}: {
	segments: readonly KeepSelectSegment[];
	/** Parallel to `segments` (one score per segment), as returned by scoreImportance. */
	importance: readonly number[];
	budgetSec?: number;
	options?: SelectOptions;
}): KeepSpan[] {
	const n = segments.length;
	if (n === 0) return [];

	const keepThreshold = options?.keepThreshold ?? KEEP_THRESHOLD;
	const minSpanSec = options?.minSpanSec ?? MIN_SPAN_SEC;
	const extendThreshold = options?.extendThreshold ?? EXTEND_THRESHOLD;
	const maxRuns = options?.maxRuns ?? MAX_RUNS;
	const dur = segments.map((s) => Math.max(0, s.end - s.start));

	// Threshold mode.
	if (budgetSec === undefined) {
		const selected = new Set<number>();
		for (let i = 0; i < n; i++) {
			if ((importance[i] ?? 0) >= keepThreshold) selected.add(i);
		}
		return spansFromSelected({ segments, selected });
	}

	// Budget ≥ everything → keep the whole timeline (complement is empty).
	const total = dur.reduce((a, b) => a + b, 0);
	if (budgetSec >= total) {
		return spansFromSelected({ segments, selected: new Set(dur.map((_, i) => i)) });
	}

	// Budget mode: contiguity-biased greedy fill.
	const order = [...dur.keys()].sort(
		(a, b) => (importance[b] ?? 0) - (importance[a] ?? 0) || a - b,
	);
	const selected = new Set<number>();
	let acc = 0;
	let runs = 0;

	for (const seed of order) {
		if (acc >= budgetSec || runs >= maxRuns) break;
		if (selected.has(seed)) continue;

		selected.add(seed);
		acc += dur[seed];
		runs++;
		let runDur = dur[seed];
		let lo = seed;
		let hi = seed;

		while (acc < budgetSec) {
			const left = lo - 1;
			const right = hi + 1;
			const leftOk = left >= 0 && !selected.has(left);
			const rightOk = right < n && !selected.has(right);
			if (!leftOk && !rightOk) break;

			let pick: number;
			if (leftOk && rightOk) {
				pick = (importance[left] ?? 0) >= (importance[right] ?? 0) ? left : right;
			} else {
				pick = leftOk ? left : right;
			}
			// Grow to the min span regardless of score (avoid slivers); past it, only
			// keep absorbing neighbors that clear the extend threshold (stay coherent).
			if (runDur >= minSpanSec && (importance[pick] ?? 0) < extendThreshold) break;

			selected.add(pick);
			runDur += dur[pick];
			acc += dur[pick];
			if (pick === left) lo = left;
			else hi = right;
		}
	}

	return spansFromSelected({ segments, selected });
}

/** Sort + merge overlapping/adjacent keep spans into a clean, timeline-ordered set. */
export function mergeSpans(spans: readonly KeepSpan[]): KeepSpan[] {
	const sorted = [...spans]
		.filter((s) => s.endSec > s.startSec)
		.sort((a, b) => a.startSec - b.startSec);
	const out: KeepSpan[] = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s.startSec <= last.endSec) last.endSec = Math.max(last.endSec, s.endSec);
		else out.push({ startSec: s.startSec, endSec: s.endSec });
	}
	return out;
}

/**
 * Assemble the final Highlight keep set + preview stats (U7). Channel split (KTD4/KTD5):
 *  - WITH a budget ("make a ~Ns short"): the deterministic contiguity-aware selection
 *    drives it — the LLM doesn't know the budget and coherence/length dominate.
 *  - WITHOUT a budget ("keep the best parts"): LLM-PRIMARY — the LLM's load-bearing
 *    keep spans, unioned with the deterministic emphasis floor as a backstop.
 * Pure; the orchestrator supplies `llmKeepSpans` from the planner's keep ops.
 */
export function buildHighlightKeeps({
	segments,
	importance,
	totalSec,
	budgetSec,
	llmKeepSpans,
}: {
	segments: readonly KeepSelectSegment[];
	importance: readonly number[];
	totalSec: number;
	budgetSec?: number;
	llmKeepSpans?: readonly KeepSpan[];
}): { keeps: KeepSpan[]; preview: HighlightPreview } {
	const keeps =
		budgetSec !== undefined
			? selectKeepSpans({ segments, importance, budgetSec })
			: mergeSpans([...(llmKeepSpans ?? []), ...selectKeepSpans({ segments, importance })]);

	const keptSec = keeps.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
	return {
		keeps,
		preview: { keptCount: keeps.length, totalCount: segments.length, keptSec, totalSec },
	};
}
