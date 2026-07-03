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
 * Word-aware accept default (2P-U2/KTD5, tightened by review F6): a shard auto-removes
 * (`defaultAccept: true`) only when the transcript PROVES it is junk on both axes: it
 * holds no complete content word AND it overlaps a transcript segment (speech was
 * happening there, so a wordless sub-floor clip is a shard of cut-up speech). A
 * wordless clip OUTSIDE speech is exactly what a deliberate visual insert (a 0.2-0.4s
 * b-roll flash, a reaction shot) looks like, so it stays an opt-in review row. A shard
 * holding a real word stays an opt-in row naming that word. With no transcript, every
 * shard stays opt-in (fail-open to keeping footage). Pure + wasm-free -> bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { stableCutId, type WordTiming } from "./cut-utils";
import { firstContentWord } from "./content-word";

/** A video clip's timeline span (seconds). */
export interface ClipSpan {
	startSec: number;
	endSec: number;
}

/** A transcript segment's span (seconds); speech was happening inside it. */
export interface SpeechSpan {
	start: number;
	end: number;
}

/**
 * Flag each video clip shorter than `minDurationSec` as a cut. A content-free shard
 * inside speech default-accepts; a shard containing a complete content word, sitting
 * outside speech (a possible visual insert), or lacking a transcript stays an opt-in
 * row. Clips at/above the threshold are left alone.
 */
export function detectTinyClipCuts({
	clips,
	minDurationSec,
	words,
	segments = [],
}: {
	clips: readonly ClipSpan[];
	minDurationSec: number;
	words?: readonly WordTiming[];
	/** Transcript segments; auto-accept requires the shard to overlap one (F6). */
	segments?: readonly SpeechSpan[];
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
		const inSpeech = segments.some(
			(s) => s.start < clip.endSec && clip.startSec < s.end,
		);
		// Auto-remove needs positive proof of junk: a transcript, no content word in the
		// shard, AND speech overlapping it (a wordless clip outside speech could be a
		// deliberate visual insert). Anything less -> opt-in row (fail-open to keep).
		const defaultAccept = hasWords && contentWord === null && inSpeech;
		const reason = contentWord
			? `Micro-clip (${durationSec.toFixed(2)}s) holding "${contentWord}" - review before removing`
			: inSpeech
				? `Stray clip (${durationSec.toFixed(2)}s) - too short to be real footage`
				: `Short clip (${durationSec.toFixed(2)}s) outside speech - could be a visual insert, review before removing`;
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
