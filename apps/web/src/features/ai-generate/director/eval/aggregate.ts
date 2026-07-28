/**
 * Golden-footage eval, variance round (U6): pure statistics over N independent
 * live draws of the same fixture (`--llm --runs N`). Round-5 lesson: a single
 * draw's numbers are too noisy to tune thresholds against, so before any
 * threshold work the runner needs mean/std/min/max across a small batch of
 * draws, not just one scorecard.
 *
 * Pure reduction over already-scored `DualScorecard[]`: no I/O, no LLM, no
 * cache, so it is unit-testable without a fixture, a live pass, or a disk
 * cache directory.
 */
import type { DualScorecard } from "./score";

export interface Stats {
	mean: number;
	std: number;
	min: number;
	max: number;
}

/** Population standard deviation (N divisor, not N-1): a `--runs N` batch IS
 * the whole sample under study, not an estimate drawn from a larger
 * population, and it keeps a single run well-defined (std 0, not NaN). */
export function stats(xs: number[]): Stats {
	if (xs.length === 0) return { mean: 0, std: 0, min: 0, max: 0 };
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	const variance =
		xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
	return {
		mean,
		std: Math.sqrt(variance),
		min: Math.min(...xs),
		max: Math.max(...xs),
	};
}

/**
 * The headline numbers this eval tunes thresholds against (docs/HANDOFF-
 * 2026-07-17.md next-work 3a). "cut recall"/"cut precision" read the OFFERED
 * bucket (the full candidate ceiling, the same bucket "kept-output match"
 * already reads), while essential-words-lost is tracked for BOTH buckets:
 * AUTO's near-harmless one-click number and OFFERED's review-ceiling number
 * are both load-bearing (see the handoff's "AUTO essLost X/Y/Z/W" /
 * "OFFERED essLost ..." citations) and neither subsumes the other.
 */
export const HEADLINE_METRICS = [
	"offered match raw",
	"offered match adj",
	"auto essential lost",
	"offered essential lost",
	"offered cut recall",
	"offered cut precision",
] as const;

export type HeadlineMetric = (typeof HEADLINE_METRICS)[number];

/** Metrics expressed as 0..1 fractions (rendered as percentages). The rest
 * (essential-words-lost) are raw word counts. */
const PERCENT_METRICS: ReadonlySet<HeadlineMetric> = new Set([
	"offered match raw",
	"offered match adj",
	"offered cut recall",
	"offered cut precision",
]);

function extract(run: DualScorecard, metric: HeadlineMetric): number {
	switch (metric) {
		case "offered match raw":
			return run.offered.matchRate;
		case "offered match adj":
			return run.offered.matchRateAdjusted;
		case "auto essential lost":
			return run.auto.essentialWordsLost;
		case "offered essential lost":
			return run.offered.essentialWordsLost;
		case "offered cut recall":
			return run.offered.cutRecall;
		case "offered cut precision":
			return run.offered.cutPrecision;
	}
}

/** mean/std/min/max for every headline metric over a batch of scored runs.
 * An empty batch reports all-zero stats for every metric (never throws). */
export function headlineStats(
	runs: readonly DualScorecard[],
): Record<HeadlineMetric, Stats> {
	const out = {} as Record<HeadlineMetric, Stats>;
	for (const metric of HEADLINE_METRICS) {
		out[metric] = stats(runs.map((r) => extract(r, metric)));
	}
	return out;
}

const fmtNum = (metric: HeadlineMetric, x: number): string =>
	PERCENT_METRICS.has(metric) ? `${(x * 100).toFixed(1)}%` : x.toFixed(1);

const METRIC_LABEL: Record<HeadlineMetric, string> = {
	"offered match raw": "offered match raw",
	"offered match adj": "offered match adj",
	"auto essential lost": "auto essential lost",
	"offered essential lost": "offered essential lost",
	"offered cut recall": "offered cut recall",
	"offered cut precision": "offered cut precision",
};

/** Render a headline-metric stats table for a `--runs N` batch (N >= 1). The
 * caller decides when to show it (the runner only calls this for `runs > 1`,
 * keeping single-run output untouched). */
export function formatAggregateTable(
	title: string,
	runs: readonly DualScorecard[],
): string {
	const table = headlineStats(runs);
	const label = Math.max(
		...HEADLINE_METRICS.map((m) => METRIC_LABEL[m].length),
	);
	const lines = [
		`-- ${title} (${runs.length} run${runs.length === 1 ? "" : "s"}) --`,
		`${"metric".padEnd(label)}  ${"mean".padStart(8)}  ${"std".padStart(8)}  ${"min".padStart(8)}  ${"max".padStart(8)}`,
	];
	for (const metric of HEADLINE_METRICS) {
		const s = table[metric];
		lines.push(
			`${METRIC_LABEL[metric].padEnd(label)}  ${fmtNum(metric, s.mean).padStart(8)}  ${fmtNum(metric, s.std).padStart(8)}  ${fmtNum(metric, s.min).padStart(8)}  ${fmtNum(metric, s.max).padStart(8)}`,
		);
	}
	return lines.join("\n");
}
