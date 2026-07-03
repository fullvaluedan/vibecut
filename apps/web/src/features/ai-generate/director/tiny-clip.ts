/**
 * Micro-clip sweep (live test: a ~2-frame stray clip got sorted to the head and left
 * in the cut; 2P-U2: pre-existing 5-15 frame shards on a shattered timeline).
 *
 * A standalone clip too short to be real content (a stray screen-grab, a corrupt
 * sliver, a mis-trim, or a shard a prior recut left behind) is invisible to every
 * other layer: it usually has no meaningful speech (so no transcript-driven detector
 * touches it), it's its OWN element (not a removal remnant, so the clip-edge snap
 * misses it), and silence removal protects whole video clips. So it survives, and the
 * chronological reorder can even promote it to the head by its timestamp. This flags
 * any video clip shorter than the shared minimum-surviving floor.
 *
 * Word-aware accept default (2P-U2/KTD5): a shard holding NO complete content word
 * auto-removes (`defaultAccept: true`); one that holds a real word stays an opt-in
 * review row naming that word. With no transcript, every shard stays opt-in (fail-open
 * to keeping footage). Pure + wasm-free -> bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { stableCutId, type WordTiming } from "./cut-utils";
import { firstContentWord } from "./content-word";

/** A video clip's timeline span (seconds). */
export interface ClipSpan {
	startSec: number;
	endSec: number;
}

/**
 * Flag each video clip shorter than `minDurationSec` as a cut. Content-free shards
 * default-accept; a shard containing a complete content word stays an opt-in row
 * (reason names the word). With no `words`, every shard is opt-in (fail-open). Clips
 * at/above the threshold are left alone.
 */
export function detectTinyClipCuts({
	clips,
	minDurationSec,
	words,
}: {
	clips: readonly ClipSpan[];
	minDurationSec: number;
	words?: readonly WordTiming[];
}): DirectorOp[] {
	if (minDurationSec <= 0) {
		return [];
	}
	const hasWords = !!words && words.length > 0;
	const ops: DirectorOp[] = [];
	for (const clip of clips) {
		const durationSec = clip.endSec - clip.startSec;
		if (durationSec <= 0 || durationSec >= minDurationSec) continue;
		const contentWord = hasWords
			? firstContentWord({ startSec: clip.startSec, endSec: clip.endSec, words })
			: null;
		// No content word (and we HAVE a transcript to prove it) -> safe to auto-remove.
		// A real word inside, or no transcript at all, -> opt-in row (fail-open to keep).
		const defaultAccept = hasWords && contentWord === null;
		const reason = contentWord
			? `Micro-clip (${durationSec.toFixed(2)}s) holding "${contentWord}" - review before removing`
			: `Stray clip (${durationSec.toFixed(2)}s) - too short to be real footage`;
		ops.push({
			id: `tiny-${stableCutId(`${clip.startSec.toFixed(3)}:${clip.endSec.toFixed(3)}`)}`,
			op: "cut",
			startSec: clip.startSec,
			endSec: clip.endSec,
			reason,
			confidence: 0.8,
			// Grouped with the other stray-fragment removals for taste learning.
			category: "noise",
			defaultAccept,
		});
	}
	return ops;
}
