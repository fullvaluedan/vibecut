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
 * Leading/trailing silence has no speech rhythm to preserve, so it gets a LOWER
 * floor (anything past the surviving-clip floor is dead weight before/after the
 * content) and cuts FLUSH at the timeline edge - padding there protects nothing
 * and used to leave a silent stub that later became a tiny head clip.
 */
const EDGE_MIN_GAP_SECONDS = 0.5;
/** Slack for float drift when testing whether a gap touches a timeline edge. */
const EDGE_EPSILON_SEC = 0.05;

/**
 * One `cut` op (category `"deadair"`) per non-speech gap longer than the floor,
 * trimmed by `padSeconds` at each SPEECH-bounded edge to keep a natural beat. A
 * gap touching the timeline start/end cuts flush at that edge with the lower
 * `EDGE_MIN_GAP_SECONDS` floor. A gap the padding would collapse emits no op.
 */
export function detectVadDeadAirCuts({
	gaps,
	minGapSeconds = DEFAULT_MIN_GAP_SECONDS,
	padSeconds = DEFAULT_PAD_SECONDS,
	totalSec,
}: {
	gaps: readonly SpeechGap[];
	minGapSeconds?: number;
	padSeconds?: number;
	/** Timeline duration (seconds); enables flush trailing-edge handling. */
	totalSec?: number;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (const gap of gaps) {
		const duration = gap.endSec - gap.startSec;
		const leading = gap.startSec <= EDGE_EPSILON_SEC;
		const trailing =
			totalSec !== undefined && gap.endSec >= totalSec - EDGE_EPSILON_SEC;
		const floor =
			leading || trailing
				? Math.min(minGapSeconds, EDGE_MIN_GAP_SECONDS)
				: minGapSeconds;
		if (duration <= floor) continue;
		const cutStart = leading ? gap.startSec : gap.startSec + padSeconds;
		const cutEnd = trailing ? gap.endSec : gap.endSec - padSeconds;
		if (cutEnd - cutStart <= 0) continue; // padding swallowed the gap
		const reason = leading
			? `Leading silence (${duration.toFixed(1)}s) before speech starts`
			: trailing
				? `Trailing silence (${duration.toFixed(1)}s) after the last speech`
				: `Silent gap (${duration.toFixed(1)}s) - dead air`;
		ops.push({
			id: `vdead-${stableCutId(`${cutStart.toFixed(3)}:${cutEnd.toFixed(3)}`)}`,
			op: "cut",
			startSec: cutStart,
			endSec: cutEnd,
			reason,
			confidence: 0.6,
			category: "deadair",
		});
	}
	return ops;
}
