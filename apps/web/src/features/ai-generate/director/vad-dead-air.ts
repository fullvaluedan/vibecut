/**
 * VAD dead-air detector (Plan A / U5). Turns long NON-SPEECH gaps (from the Silero
 * VAD pass) into reviewable "dead air" Director cut ops — the silent "just sitting
 * there" stretches that a text-only transcript can't see. Pure + wasm-free →
 * unit-tested. The overlap-filter against the other cuts lives at the run-director
 * wiring (mirrors the `segmentRepeatCuts` filter), so this stays a clean gaps→ops
 * mapping and never double-flags with `pacing` / `dead-air`.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { stableCutId } from "./cut-utils";

/** A non-speech interval (seconds, timeline-absolute) from the VAD pass. */
export interface SpeechGap {
	startSec: number;
	endSec: number;
}

/** A gap shorter than this isn't worth a cut row. */
const DEFAULT_MIN_GAP_SECONDS = 1.5;
/** Leave this much silence at each edge so the cut doesn't butt against speech. */
const DEFAULT_PAD_SECONDS = 0.3;

/**
 * One `cut` op (category `"deadair"`) per non-speech gap longer than
 * `minGapSeconds`, trimmed by `padSeconds` at each edge to keep a natural beat.
 * A gap that the padding would collapse to nothing emits no op.
 */
export function detectVadDeadAirCuts({
	gaps,
	minGapSeconds = DEFAULT_MIN_GAP_SECONDS,
	padSeconds = DEFAULT_PAD_SECONDS,
}: {
	gaps: readonly SpeechGap[];
	minGapSeconds?: number;
	padSeconds?: number;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (const gap of gaps) {
		const duration = gap.endSec - gap.startSec;
		if (duration <= minGapSeconds) continue;
		const cutStart = gap.startSec + padSeconds;
		const cutEnd = gap.endSec - padSeconds;
		if (cutEnd - cutStart <= 0) continue; // padding swallowed the gap
		ops.push({
			id: `vdead-${stableCutId(`${cutStart.toFixed(3)}:${cutEnd.toFixed(3)}`)}`,
			op: "cut",
			startSec: cutStart,
			endSec: cutEnd,
			reason: `Silent gap (${duration.toFixed(1)}s) — dead air`,
			confidence: 0.6,
			category: "deadair",
		});
	}
	return ops;
}
