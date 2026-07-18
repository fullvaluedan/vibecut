/**
 * Envelope dead-air detector (round 6 U2): cut long PURE-SILENCE blocks
 * straight from the shared RMS envelope, no VAD model required, on every run.
 *
 * The transcript cannot see silence (silence has no words) and Whisper
 * actively hallucinates text over it, so until this pass the only default
 * remover of a 24s dead-air tail was luck. Silence here is ENVELOPE-defined
 * (KTD1): windows below min(SILENCE_RMS_CEILING, screened-median x
 * MEDIAN_RATIO), the same threshold family as the hallucination guard and the
 * standalone Remove Silences detector.
 *
 * AUTO re-entry for silence is narrow and cut-storm-proof by construction
 * (KTD4, Dan-approved 2026-07-17): only runs at or above AUTO_MIN_RUN_SEC with
 * ZERO clean-word midpoints inside are eligible, each cut leaves a
 * KEEP_BEAT_PAD_SEC breath on speech-bounded sides, edge gaps cut flush with
 * the lower EDGE floor (vad-dead-air precedent), and a run covering most of
 * the timeline stays an opt-in row. A run containing a real word is simply
 * not eligible, so this pass cannot remove speech.
 *
 * `computeSilenceRuns` is shared with the pause-swallowing boundary pass (U3)
 * so both read silence identically. Pure + wasm-free, seconds in and out.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { isMidpointContained, stableCutId } from "./cut-utils";
import { computeSilenceThreshold } from "./hallucination-guard";

export { computeSilenceThreshold };

/** Interior silence runs at or above this duration are AUTO dead-air cuts. */
export const AUTO_MIN_RUN_SEC = 2.5;
/** Breath left on each speech-bounded side of a cut (mirrors remove-silences PADDING_SEC). */
export const KEEP_BEAT_PAD_SEC = 0.15;
/** Leading/trailing silence floor (mirrors vad-dead-air EDGE_MIN_GAP_SECONDS). */
export const EDGE_MIN_RUN_SEC = 0.5;
/** Slack for float drift when testing whether a run touches a timeline edge. */
const EDGE_EPSILON_SEC = 0.05;
/** A cut covering more than this fraction of the timeline is never auto-accepted. */
const MAX_AUTO_ACCEPT_TIMELINE_FRACTION = 0.8;

export interface SilenceRun {
	startSec: number;
	endSec: number;
}

/** Maximal contiguous runs of sub-threshold envelope windows, in seconds. */
export function computeSilenceRuns({
	envelope,
	windowSec,
	threshold,
}: {
	envelope: readonly number[];
	windowSec: number;
	threshold: number;
}): SilenceRun[] {
	const runs: SilenceRun[] = [];
	let runStart = -1;
	for (let w = 0; w < envelope.length; w++) {
		const silent = envelope[w] < threshold;
		if (silent && runStart < 0) {
			runStart = w;
		} else if (!silent && runStart >= 0) {
			runs.push({ startSec: runStart * windowSec, endSec: w * windowSec });
			runStart = -1;
		}
	}
	if (runStart >= 0) {
		runs.push({ startSec: runStart * windowSec, endSec: envelope.length * windowSec });
	}
	return runs;
}

/**
 * One `cut` op (category "deadair", id `edead-`) per eligible pure-silence
 * run. See the module header for the eligibility and guard rules.
 */
export function detectEnvelopeDeadAirCuts({
	envelope,
	windowSec,
	threshold,
	words,
	totalSec,
}: {
	envelope: readonly number[];
	windowSec: number;
	threshold: number;
	/** CLEAN words (post hallucination-guard); a run holding a midpoint is ineligible. */
	words: readonly { start: number; end: number }[];
	totalSec: number;
}): DirectorOp[] {
	if (envelope.length === 0) {
		return [];
	}
	const audioEndSec = envelope.length * windowSec;
	const ops: DirectorOp[] = [];
	for (const run of computeSilenceRuns({ envelope, windowSec, threshold })) {
		const holdsWord = words.some((w) =>
			isMidpointContained({
				spanStart: w.start,
				spanEnd: w.end,
				containerStart: run.startSec,
				containerEnd: run.endSec,
			}),
		);
		if (holdsWord) continue;

		const duration = run.endSec - run.startSec;
		const leading = run.startSec <= EDGE_EPSILON_SEC;
		// The envelope drops a partial tail window, so the audio end can sit a
		// hair before totalSec; treat a run reaching the envelope end as trailing
		// only when the envelope itself reaches (near) the timeline end. A
		// timeline extending far past the decoded audio says nothing about
		// silence there, so those runs stay interior (conservative).
		const audioCoversTimeline = totalSec - audioEndSec <= windowSec * 2;
		const trailing =
			run.endSec >= audioEndSec - EDGE_EPSILON_SEC && audioCoversTimeline;
		const floor = leading || trailing ? EDGE_MIN_RUN_SEC : AUTO_MIN_RUN_SEC;
		if (duration < floor) continue;

		// Flush edges never extend past the RUN's own bounds toward audio the
		// detector classified as non-silent: a run starting at 0.05 because
		// window 0 is loud (an intro transient) must not swallow that window.
		// A true head run starts at 0 and cuts flush from 0 anyway.
		const cutStart = leading ? run.startSec : run.startSec + KEEP_BEAT_PAD_SEC;
		const cutEnd = trailing ? totalSec : run.endSec - KEEP_BEAT_PAD_SEC;
		if (cutEnd - cutStart <= 0) continue; // padding swallowed the run

		const wholeTimeline =
			cutEnd - cutStart > totalSec * MAX_AUTO_ACCEPT_TIMELINE_FRACTION;
		const reason = leading
			? `Leading silence (${duration.toFixed(1)}s) before speech starts`
			: trailing
				? `Trailing silence (${duration.toFixed(1)}s) after the last speech`
				: `Silent stretch (${duration.toFixed(1)}s) with no speech - dead air`;
		ops.push({
			id: `edead-${stableCutId(`${cutStart.toFixed(3)}:${cutEnd.toFixed(3)}`)}`,
			op: "cut",
			startSec: cutStart,
			endSec: cutEnd,
			reason,
			confidence: 0.7,
			category: "deadair",
			...(wholeTimeline ? { defaultAccept: false } : {}),
		});
	}
	return ops;
}
