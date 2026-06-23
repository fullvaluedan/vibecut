/**
 * Useless tiny-clip guard (live test: a ~2-frame stray clip got sorted to the head
 * and left in the cut).
 *
 * A standalone clip too short to be real content (a stray screen-grab, a corrupt
 * sliver, a mis-trim) is invisible to every other layer: it usually has no speech
 * (so no transcript-driven detector touches it), it's its OWN element (not a removal
 * remnant, so the clip-edge snap misses it), and silence removal protects whole video
 * clips. So it survives — and the chronological reorder can even promote it to the
 * head by its timestamp. This flags any video clip shorter than a minimum useful
 * length as a cut, surfaced in the Review modal (flagged, not auto-applied), so the
 * user confirms before a clip is removed.
 *
 * Pure + wasm-free → bun-testable. Conservative threshold: only CLEARLY-junk clips
 * (a few frames) trip it, so a real short utterance left by silence-removal isn't
 * proposed for removal.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { stableCutId } from "./cut-utils";

/** A video clip's timeline span (seconds). */
export interface ClipSpan {
	startSec: number;
	endSec: number;
}

/**
 * Flag each video clip shorter than `minDurationSec` as a cut. Returns one removal
 * op per tiny clip; clips at/above the threshold are left alone.
 */
export function detectTinyClipCuts({
	clips,
	minDurationSec,
}: {
	clips: readonly ClipSpan[];
	minDurationSec: number;
}): DirectorOp[] {
	if (minDurationSec <= 0) {
		return [];
	}
	const ops: DirectorOp[] = [];
	for (const clip of clips) {
		const durationSec = clip.endSec - clip.startSec;
		if (durationSec > 0 && durationSec < minDurationSec) {
			ops.push({
				id: `tiny-${stableCutId(`${clip.startSec.toFixed(3)}:${clip.endSec.toFixed(3)}`)}`,
				op: "cut",
				startSec: clip.startSec,
				endSec: clip.endSec,
				reason: `Stray clip (${durationSec.toFixed(2)}s) — too short to be real footage`,
				confidence: 0.8,
				// Grouped with the other stray-fragment removals for taste learning.
				category: "noise",
			});
		}
	}
	return ops;
}
