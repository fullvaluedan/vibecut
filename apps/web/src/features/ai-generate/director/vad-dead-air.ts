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
/**
 * Extra silence to leave at each speech-bounded gap edge. Defaults to 0 because
 * the VAD speech-edge padding (`refineSpeechIntervals`, U6 asymmetric head/tail)
 * is now the single silence-margin source, so the gaps arriving here are already
 * trimmed and must not be padded twice. Kept as an honored override so U7 can
 * dial an additional trim without another code change.
 */
const DEFAULT_PAD_SECONDS = 0;
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
 * A cut covering more than this fraction of the timeline is never auto-accepted:
 * one checked row must not be able to wipe a whole (hallucinated-transcript /
 * music-only) timeline by default.
 */
const MAX_AUTO_ACCEPT_TIMELINE_FRACTION = 0.8;

/**
 * One `cut` op (category `"deadair"`) per non-speech gap longer than the floor,
 * trimmed by `padSeconds` at each SPEECH-bounded edge to keep a natural beat. A
 * gap touching the timeline start/end cuts flush at that edge with the lower
 * `EDGE_MIN_GAP_SECONDS` floor. A gap the padding would collapse emits no op.
 *
 * Silero gaps mean NON-SPEECH, not silence (review X5): an edge gap that carries
 * real audio energy (a music sting, a b-roll cold open) surfaces as an OPT-IN row
 * with an honest reason instead of a default-accepted "silence" cut. Same for any
 * cut spanning most of the timeline.
 */
export function detectVadDeadAirCuts({
	gaps,
	minGapSeconds = DEFAULT_MIN_GAP_SECONDS,
	padSeconds = DEFAULT_PAD_SECONDS,
	totalSec,
	isEnergetic,
}: {
	gaps: readonly SpeechGap[];
	minGapSeconds?: number;
	padSeconds?: number;
	/** Timeline duration (seconds); enables flush trailing-edge handling. */
	totalSec?: number;
	/** True when a gap carries real audio energy (music/b-roll, not silence). */
	isEnergetic?: (gap: SpeechGap) => boolean;
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	for (const gap of gaps) {
		const duration = gap.endSec - gap.startSec;
		const leading = gap.startSec <= EDGE_EPSILON_SEC;
		const trailing =
			totalSec !== undefined && gap.endSec >= totalSec - EDGE_EPSILON_SEC;
		const floor = leading || trailing ? EDGE_MIN_GAP_SECONDS : minGapSeconds;
		if (duration <= floor) continue;
		const cutStart = leading ? gap.startSec : gap.startSec + padSeconds;
		const cutEnd = trailing ? gap.endSec : gap.endSec - padSeconds;
		if (cutEnd - cutStart <= 0) continue; // padding swallowed the gap
		const energeticEdge =
			(leading || trailing) && isEnergetic !== undefined && isEnergetic(gap);
		const wholeTimeline =
			totalSec !== undefined &&
			cutEnd - cutStart > totalSec * MAX_AUTO_ACCEPT_TIMELINE_FRACTION;
		const reason = energeticEdge
			? `Non-speech ${leading ? "opening" : "ending"} (${duration.toFixed(1)}s) with audio (music or b-roll?) - review before removing`
			: leading
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
			...(energeticEdge || wholeTimeline ? { defaultAccept: false } : {}),
		});
	}
	return ops;
}
