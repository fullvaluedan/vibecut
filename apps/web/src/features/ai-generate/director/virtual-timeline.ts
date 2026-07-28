/**
 * Virtual-apply module (round 14 U1): the pure heart of the multi-pass Director's
 * SECOND cut. Given the transcript senses and a set of default-accepted removal
 * ops, it materializes the ASSEMBLED state - the words/segments/features/envelope
 * as the video reads AFTER the first cut applies - plus a monotonic, piecewise-
 * linear coordinate map assembledSec -> sourceSec. P2 re-reads that assembled
 * state with the LLM plan + redundancy passes; the map carries every finding back
 * to SOURCE coordinates for the merge.
 *
 * A cut only DELETES time, it never scales it, so within every KEPT span the map
 * has slope 1 and the whole map is a staircase of unit-slope segments meeting at
 * the cut seams. `mergeAcceptedRemovalSpans` (the round-13 helper, shared with
 * assembled-transcript.ts) is the single source of "what the assembled result
 * removes", and word/segment membership uses the SAME midpoint rule
 * assembled-transcript.ts uses, so this module and the join/verify materialization
 * can never drift on which words survive.
 *
 * Pure + wasm-free -> bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import type { SpeechFeatures } from "./types";
import type { TranscriptSegment } from "./build-signal-table";
import {
	isMidpointContained,
	mergeAcceptedRemovalSpans,
	stableCutId,
	type WordTiming,
} from "./cut-utils";

/** A disjoint removal span in seconds. */
export interface RemovalSpan {
	startSec: number;
	endSec: number;
}

/** One retained region: its SOURCE bounds and its ASSEMBLED (post-cut) bounds.
 * Within it the map is the identity shifted left by the removed time before it. */
export interface KeptSpan {
	sourceStartSec: number;
	sourceEndSec: number;
	assembledStartSec: number;
	assembledEndSec: number;
}

/**
 * The monotonic coordinate map between the two timelines. `toSource` is the
 * direction P2 needs (its findings arrive in assembled seconds); `toAssembled` is
 * the inverse, used to remap the surviving words/segments and to round-trip test.
 */
export interface AssembledCoordinateMap {
	/** The retained regions in order, source-ascending == assembled-ascending. */
	keptSpans: KeptSpan[];
	/** Total SOURCE duration (the input `totalSec`). */
	sourceTotalSec: number;
	/** Total ASSEMBLED duration (source minus every removed span). */
	assembledTotalSec: number;
	/**
	 * Map an ASSEMBLED time to its SOURCE time. At a cut seam the assembled point
	 * is ambiguous - it is both the end of the content before the cut and the start
	 * of the content after it - so `edge` breaks the tie the same way the second-
	 * pass inverse remap does: `"start"` (default) lands on the content AFTER the
	 * collapse (the later source), `"end"` on the content BEFORE it (the earlier
	 * source). Strictly inside a kept span the two agree.
	 */
	toSource(assembledSec: number, edge?: "start" | "end"): number;
	/**
	 * Map a SOURCE time to its ASSEMBLED time. A source point inside a removed span
	 * has no assembled image, so it snaps to that removal's collapse seam (the
	 * assembled end of the last kept span before it).
	 */
	toAssembled(sourceSec: number): number;
}

/** Floating-point slack for seam comparisons (well below one video frame). */
const EPS = 1e-9;

/**
 * Build the coordinate map from a set of removal spans over `[0, totalSec]`. The
 * removals are clamped to that range, dropped when empty, sorted, and unioned so
 * overlapping/touching input still yields clean disjoint kept spans (the map math
 * assumes disjoint removals). Empty removals => one kept span covering the whole
 * timeline, an identity map.
 */
export function buildCoordinateMap({
	removals,
	totalSec,
}: {
	removals: readonly { startSec: number; endSec: number }[];
	totalSec: number;
}): AssembledCoordinateMap {
	const clamped = removals
		.map((r) => ({
			startSec: Math.max(0, Math.min(r.startSec, totalSec)),
			endSec: Math.max(0, Math.min(r.endSec, totalSec)),
		}))
		.filter((r) => r.endSec > r.startSec)
		.sort((a, b) => a.startSec - b.startSec);
	// Union overlaps so the sweep below sees disjoint ranges (defensive: the caller
	// passes mergeAcceptedRemovalSpans output, already disjoint).
	const merged: RemovalSpan[] = [];
	for (const r of clamped) {
		const last = merged[merged.length - 1];
		if (last && r.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, r.endSec);
		} else {
			merged.push({ ...r });
		}
	}

	const keptSpans: KeptSpan[] = [];
	let cursor = 0;
	let removed = 0;
	for (const r of merged) {
		if (r.startSec > cursor) {
			keptSpans.push({
				sourceStartSec: cursor,
				sourceEndSec: r.startSec,
				assembledStartSec: cursor - removed,
				assembledEndSec: r.startSec - removed,
			});
		}
		removed += r.endSec - r.startSec;
		cursor = r.endSec;
	}
	if (cursor < totalSec) {
		keptSpans.push({
			sourceStartSec: cursor,
			sourceEndSec: totalSec,
			assembledStartSec: cursor - removed,
			assembledEndSec: totalSec - removed,
		});
	}
	const assembledTotalSec = Math.max(0, totalSec - removed);

	function toSource(assembledSec: number, edge: "start" | "end" = "start"): number {
		if (keptSpans.length === 0) return 0;
		const a = Math.max(0, Math.min(assembledSec, assembledTotalSec));
		// The chosen span is the LAST one whose assembled start is at/before `a`
		// (edge "start", inclusive) or strictly before `a` (edge "end", exclusive).
		// At a seam that picks the AFTER span for "start" (later source) and the
		// BEFORE span for "end" (earlier source); strictly inside a span both agree.
		let chosen = keptSpans[0];
		for (const span of keptSpans) {
			const past =
				edge === "start"
					? a >= span.assembledStartSec - EPS
					: a > span.assembledStartSec + EPS;
			if (past) chosen = span;
		}
		return a + (chosen.sourceStartSec - chosen.assembledStartSec);
	}

	function toAssembled(sourceSec: number): number {
		if (keptSpans.length === 0) return 0;
		const s = Math.max(0, Math.min(sourceSec, totalSec));
		for (const span of keptSpans) {
			if (s >= span.sourceStartSec - EPS && s <= span.sourceEndSec + EPS) {
				return s - (span.sourceStartSec - span.assembledStartSec);
			}
		}
		// Inside a removed span: snap to the collapse seam (the assembled end of the
		// last kept span that ends at/before this source point).
		let seam = 0;
		for (const span of keptSpans) {
			if (span.sourceEndSec <= s + EPS) seam = span.assembledEndSec;
		}
		return seam;
	}

	return {
		keptSpans,
		sourceTotalSec: totalSec,
		assembledTotalSec,
		toSource,
		toAssembled,
	};
}

/** The materialized assembled state plus the map back to source coordinates. */
export interface VirtualTimeline {
	/** Surviving words with ASSEMBLED timings (source order preserved). */
	words: WordTiming[];
	/** Surviving segments with ASSEMBLED timings. */
	segments: TranscriptSegment[];
	/** Features for the surviving segments, kept PARALLEL to `segments`, with their
	 * startSec/endSec remapped to assembled time. */
	features: SpeechFeatures[];
	/** RMS energy envelope resampled onto the assembled timeline. */
	envelope: number[];
	/** The coordinate map (assembled <-> source). */
	map: AssembledCoordinateMap;
	/** Total SOURCE seconds the default-accepted removals delete. */
	removedSec: number;
}

/**
 * Materialize the assembled state after the DEFAULT-ACCEPTED removals in `ops`.
 * A word/segment SURVIVES when its midpoint is not inside a merged accepted
 * removal (the assembled-transcript rule). Survivors keep every field; only their
 * timings shift to assembled coordinates. `features` must be parallel to
 * `segments` (one per segment, as the pipeline builds them); each surviving
 * segment carries its feature forward with remapped bounds. Pure.
 */
export function buildVirtualTimeline({
	words,
	segments,
	features,
	envelope,
	windowSec,
	ops,
	totalSec,
}: {
	words: readonly WordTiming[];
	segments: readonly TranscriptSegment[];
	features: readonly SpeechFeatures[];
	envelope: readonly number[];
	windowSec: number;
	ops: readonly DirectorOp[];
	totalSec: number;
}): VirtualTimeline {
	const removals = mergeAcceptedRemovalSpans(ops);
	const map = buildCoordinateMap({ removals, totalSec });
	const removedSec = map.sourceTotalSec - map.assembledTotalSec;

	const survives = (start: number, end: number): boolean =>
		!removals.some((r) =>
			isMidpointContained({
				spanStart: start,
				spanEnd: end,
				containerStart: r.startSec,
				containerEnd: r.endSec,
			}),
		);

	const outWords: WordTiming[] = [];
	for (const w of words) {
		if (!survives(w.start, w.end)) continue;
		outWords.push({ ...w, start: map.toAssembled(w.start), end: map.toAssembled(w.end) });
	}

	const outSegments: TranscriptSegment[] = [];
	const outFeatures: SpeechFeatures[] = [];
	segments.forEach((seg, i) => {
		if (!survives(seg.start, seg.end)) return;
		const start = map.toAssembled(seg.start);
		const end = map.toAssembled(seg.end);
		outSegments.push({ ...seg, start, end });
		const f = features[i];
		if (f) outFeatures.push({ ...f, startSec: start, endSec: end });
	});

	return {
		words: outWords,
		segments: outSegments,
		features: outFeatures,
		envelope: remapEnvelope({ envelope, windowSec, map }),
		map,
		removedSec,
	};
}

/**
 * Resample a windowed RMS envelope onto the assembled timeline: for each assembled
 * window, map its midpoint back to source and read the source envelope there.
 * Empty envelope or a non-positive window yields `[]`. Pure.
 */
export function remapEnvelope({
	envelope,
	windowSec,
	map,
}: {
	envelope: readonly number[];
	windowSec: number;
	map: AssembledCoordinateMap;
}): number[] {
	if (envelope.length === 0 || windowSec <= 0) return [];
	const outLen = Math.max(0, Math.ceil(map.assembledTotalSec / windowSec));
	const out = new Array<number>(outLen);
	for (let j = 0; j < outLen; j++) {
		const assembledMid = (j + 0.5) * windowSec;
		const sourceSec = map.toSource(assembledMid, "start");
		const idx = Math.min(envelope.length - 1, Math.max(0, Math.floor(sourceSec / windowSec)));
		out[j] = envelope[idx];
	}
	return out;
}

/**
 * The second-pass reason marker. A P2 op's reason is prefixed with this so the
 * review dock shows pass provenance and the AUTO/OFFERED eval reads it as a second
 * cut WITHOUT any new DirectorOp field or category (round 14 U1: the DirectorOp
 * shape and the taste category checklist are untouched).
 */
export const SECOND_PASS_REASON_PREFIX = "Second pass: ";

/**
 * Carry P2's removal ops (found in ASSEMBLED coordinates) back to SOURCE
 * coordinates through the map. Only `cut`/`take_select` cross over - a P2 keep or
 * reorder over the assembled result has no safe source image and is dropped. Each
 * op's start maps on the "start" edge and its end on the "end" edge, so a span that
 * straddles a P1 cut seam expands to cover both kept runs it selects (the trim step
 * then subtracts the removed gap between them). Ids regenerate under the `p2-`
 * namespace so they can never collide with a P1 id. Pure.
 */
export function mapAssembledOpsToSource({
	ops,
	map,
}: {
	ops: readonly DirectorOp[];
	map: AssembledCoordinateMap;
}): DirectorOp[] {
	const out: DirectorOp[] = [];
	for (const op of ops) {
		if (op.op !== "cut" && op.op !== "take_select") continue;
		const startSec = map.toSource(op.startSec, "start");
		const endSec = map.toSource(op.endSec, "end");
		if (!(endSec > startSec)) continue;
		out.push({
			...op,
			startSec,
			endSec,
			id: `p2-${stableCutId(`${op.category ?? op.op}:${startSec.toFixed(3)}:${endSec.toFixed(3)}`)}`,
		});
	}
	return out;
}

/**
 * Tag a mapped P2 op as a second-cut row: prefix its reason with
 * `SECOND_PASS_REASON_PREFIX` (idempotent) and force it OFFERED
 * (`defaultAccept: false`). P2 rows never start checked - the harm net that would
 * let a second cut auto-apply is the round-14 P3 (a separate unit), so until then
 * a second cut only ever adds review rows, never auto-removes footage. The group
 * link is dropped: P2 redundancy cuts carry no review group to swap against. Pure.
 */
export function tagSecondPass(op: DirectorOp): DirectorOp {
	const base = op.reason ?? "";
	const reason = base.startsWith(SECOND_PASS_REASON_PREFIX)
		? base.slice(0, 240)
		: `${SECOND_PASS_REASON_PREFIX}${base}`.slice(0, 240);
	const { groupId: _groupId, ...rest } = op;
	return { ...rest, reason, defaultAccept: false };
}
