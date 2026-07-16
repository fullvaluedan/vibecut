/**
 * Span discipline for the LLM PLAN pass (U2, R5/KTD4). The plan pass reasons at the
 * segment level and routinely emits a single "cut" spanning 20-300s that engulfs kept
 * dialog, the measured essential-words-lost driver. `refineCutWordBounds` fixes the
 * EDGES of a removal but cannot shrink an oversized span's EXTENT; this pass does.
 *
 * Runs on the plan-pass ops ONLY, immediately after `planOps` forms and BEFORE
 * `mergeDetectedCuts` (KTD4). Selection is by ARRAY MEMBERSHIP (the caller hands us
 * only the plan-pass ops), never by category: a vision-tagged plan op is disciplined
 * exactly like an untagged one. The deterministic detector arrays are never passed in.
 *
 * Per plan REMOVAL op (`cut`/`take_select`) LONGER than OVERSIZED_SPAN_SEC:
 *  - EVIDENCED: when deterministically-evidenced removable runs (take-cluster,
 *    phrase-repeat, filler/dead-air/duplicate/pacing word runs) cover at least
 *    MIN_EVIDENCE_COVERAGE of the span, SHRINK the op to the union of those runs
 *    (clipped to the span), splitting disjoint evidence into multiple ops. The kept
 *    dialog between the evidence survives; only the evidenced junk leaves.
 *  - UNEVIDENCED: when evidence covers too little (or none), DEMOTE the op unchanged to
 *    a review row (`defaultAccept: false`). AUTO stops auto-cutting it; OFFERED still
 *    offers the whole span, so recall is preserved (a wholesale tangent Dan cuts by hand
 *    stays offered, never silently under-trimmed).
 *
 * Invariants: never GROW a span (shrunk runs are clipped to the op); never touch
 * `keep`/`reorder`; ops at/below the threshold pass through BYTE-IDENTICAL; a shrink
 * that collapses to zero span drops the op. Fail-open: with no words (a degraded,
 * word-timing-less transcript) the evidence detectors produced nothing meaningful and
 * word-safety can't be reasoned about, so every op passes through unchanged, which mirrors
 * `refineCutWordBounds`/`justifyCuts`. Pure + wasm-free; seconds in, seconds out. Only
 * `startSec`/`endSec` matter downstream (KTD1), so split ops get fresh stable ids.
 */

import { stableOpId, type DirectorOp } from "@framecut/hf-bridge";
import type { WordTiming } from "./cut-utils";

/**
 * Tuned on the 4-fixture `--llm` scorecard, 2026-07-16 (google-omni, hermes-cloud,
 * how-to-edit, pokemon-tcg). A plan removal must exceed this length to be disciplined;
 * shorter cuts are edge-refined downstream and left alone here. 20s clears a normal
 * multi-sentence removal while catching the 20-300s span-engulfers. Below 20s the
 * AUTO-match dip from demoting legitimate mid-length cuts grew; at 30s the second-pass
 * interaction regressed pokemon-tcg OFFERED match; 20s was the measured sweet spot.
 */
export const OVERSIZED_SPAN_SEC = 20;

/**
 * Tuned 2026-07-16. The minimum fraction of an oversized span that deterministic evidence
 * must cover to SHRINK it to that evidence; below this the span is DEMOTED whole to a
 * review row instead. Set HIGH (0.5) because the measured trade-off is one-sided: shrink
 * drops the non-evidenced remainder from BOTH auto and offered, and on all four fixtures
 * that remainder was material Dan actually cut, so every shrink in the 0.2-0.35 coverage
 * band cost OFFERED recall 1.5-3pp for only a fractional AUTO-match gain. Demote instead
 * preserves OFFERED recall (the whole span stays offered) while still pulling the engulfer
 * out of AUTO. Shrink stays reserved for the genuinely evidence-DENSE oversized cut (mostly
 * removable junk around a little kept dialog), where excising it is near-lossless for recall.
 */
export const MIN_EVIDENCE_COVERAGE = 0.5;

/** A deterministically-evidenced removable run, in timeline seconds. */
export interface EvidenceSpan {
	startSec: number;
	endSec: number;
}

const isRemoval = (op: DirectorOp): boolean =>
	op.op === "cut" || op.op === "take_select";

/** Sort spans by start and merge overlapping OR touching ones into disjoint runs. */
function unionRuns(runs: EvidenceSpan[]): EvidenceSpan[] {
	const sorted = [...runs].sort((a, b) => a.startSec - b.startSec);
	const merged: EvidenceSpan[] = [];
	for (const r of sorted) {
		const last = merged[merged.length - 1];
		if (last && r.startSec <= last.endSec) {
			if (r.endSec > last.endSec) last.endSec = r.endSec;
		} else {
			merged.push({ startSec: r.startSec, endSec: r.endSec });
		}
	}
	return merged;
}

/** Demote an op to an opt-in review row, span untouched. */
function demote(op: DirectorOp): DirectorOp {
	return { ...op, defaultAccept: false };
}

/**
 * Discipline the LLM plan-pass ops' cut EXTENT against deterministic evidence. Returns a
 * new op list: oversized removals shrunk to their evidenced runs or demoted to review
 * rows; every other op passed through unchanged.
 */
export function clampCutExtent({
	ops,
	words,
	evidence,
	oversizedSpanSec = OVERSIZED_SPAN_SEC,
	minEvidenceCoverage = MIN_EVIDENCE_COVERAGE,
}: {
	ops: readonly DirectorOp[];
	words?: readonly WordTiming[];
	evidence?: readonly EvidenceSpan[];
	/** Override the oversized-span trigger (defaults to the tuned constant). */
	oversizedSpanSec?: number;
	/** Override the shrink-vs-demote coverage floor (defaults to the tuned constant). */
	minEvidenceCoverage?: number;
}): DirectorOp[] {
	if (!words || words.length === 0) return [...ops]; // fail-open: degraded transcript

	const ev = evidence ?? [];
	const out: DirectorOp[] = [];
	for (const op of ops) {
		if (!isRemoval(op)) {
			out.push(op); // keep/reorder untouched
			continue;
		}
		const len = op.endSec - op.startSec;
		if (len <= oversizedSpanSec) {
			out.push(op); // below threshold → byte-identical
			continue;
		}

		// Oversized removal. Gather evidence overlapping the span, clipped to it.
		const overlapping = ev.filter(
			(e) => e.startSec < op.endSec && op.startSec < e.endSec,
		);
		if (overlapping.length === 0) {
			out.push(demote(op)); // no evidence at all → demote whole span
			continue;
		}
		const clipped = overlapping
			.map((e) => ({
				startSec: Math.max(e.startSec, op.startSec),
				endSec: Math.min(e.endSec, op.endSec),
			}))
			.filter((r) => r.endSec > r.startSec);
		const runs = unionRuns(clipped);
		if (runs.length === 0) {
			// Evidence overlapped but every run collapsed to zero width → drop the op.
			continue;
		}
		const covered = runs.reduce((a, r) => a + (r.endSec - r.startSec), 0);
		if (covered / len < minEvidenceCoverage) {
			out.push(demote(op)); // too little evidence to shrink → demote whole span
			continue;
		}

		// Enough evidence → shrink to the union, one op per disjoint run. Preserve every
		// field (reason/confidence/category/defaultAccept); only start/end change, so
		// regenerate the id per new span.
		for (const r of runs) {
			out.push({
				...op,
				startSec: r.startSec,
				endSec: r.endSec,
				// The shared hf-bridge hash keeps split-op ids in the plan-op namespace
				// (stable across re-planning); regenerated so two disjoint shrunk ops
				// never collide on the parent's id. Only start/end matter downstream (KTD1).
				id: stableOpId({
					op: op.op,
					startSec: r.startSec,
					endSec: r.endSec,
					targetStartSec: op.targetStartSec,
				}),
			});
		}
	}
	return out;
}
