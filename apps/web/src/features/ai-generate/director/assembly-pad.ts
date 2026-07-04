/**
 * Breathing room for the auto-assembled cut (issue E, Auto-assemble).
 *
 * The assembler lays segment-aligned source spans from DIFFERENT clips back-to-
 * back, so a join can cut straight from one clip's last syllable to another clip's
 * first — abrupt. The Director/Highlight snap uses the timeline energy envelope,
 * but assemble has no envelope at placement time (cached runs skip the audio
 * decode). Instead it uses the transcript's own structure: the gap BEFORE/AFTER a
 * segment (where Whisper found no speech) is the source's silence, so each chosen
 * span is expanded a little into its surrounding gap. Each clip then carries a
 * silent head/tail and the joins land in the quiet.
 *
 * Pure + wasm-free → bun-testable. Safe by construction: the expansion is clamped
 * to the neighbouring segment boundaries (never eats adjacent speech), to the clip
 * bounds [0, duration], and to a small pad. Applied ONCE to the draft so the review
 * panel's floating timecodes and the placement stay consistent.
 */

import type { AssemblyDraft, DraftSpan, SpanAlternate } from "./assembly-draft";
import type { CandidateSpan } from "./candidate-pool";

/** Breathing room added on each side, when the surrounding gap allows (~2 frames). */
export const DEFAULT_ASSEMBLE_PAD_SEC = 0.06;

/** Tiny tolerance so a segment that abuts the boundary isn't treated as overlapping. */
const EPS = 1e-3;

interface Seg {
	start: number;
	end: number;
}

/** Group the pool's segments by asset (sorted is not required — we scan for extrema). */
function segmentsByAsset(pool: readonly CandidateSpan[]): Map<string, Seg[]> {
	const map = new Map<string, Seg[]>();
	for (const c of pool) {
		const list = map.get(c.assetId);
		const seg = { start: c.sourceStartSec, end: c.sourceEndSec };
		if (list) list.push(seg);
		else map.set(c.assetId, [seg]);
	}
	return map;
}

/**
 * Expand one span's [startSec,endSec] into its surrounding silence, bounded by the
 * nearest same-asset segment on each side (the gap to it), the clip bounds, and
 * `padSec`. Returns the padded bounds.
 */
export function padSpanIntoSilence({
	startSec,
	endSec,
	durationSec,
	segments,
	padSec = DEFAULT_ASSEMBLE_PAD_SEC,
}: {
	startSec: number;
	endSec: number;
	durationSec: number;
	segments: readonly Seg[];
	padSec?: number;
}): { startSec: number; endSec: number } {
	let predEnd = Number.NEGATIVE_INFINITY; // closest segment end at/before this start
	let succStart = Number.POSITIVE_INFINITY; // closest segment start at/after this end
	for (const s of segments) {
		if (s.end <= startSec + EPS && s.end > predEnd) predEnd = s.end;
		if (s.start >= endSec - EPS && s.start < succStart) succStart = s.start;
	}
	// Headroom: gap back to the previous segment (or the clip head when none).
	const headroom =
		predEnd === Number.NEGATIVE_INFINITY ? Math.max(0, startSec) : Math.max(0, startSec - predEnd);
	// Tailroom: gap forward to the next segment (or the clip tail when none).
	const tailroom =
		succStart === Number.POSITIVE_INFINITY
			? Math.max(0, durationSec - endSec)
			: Math.max(0, succStart - endSec);

	const newStart = Math.max(0, startSec - Math.min(padSec, headroom));
	const cappedEnd = durationSec > 0 ? Math.min(durationSec, endSec + Math.min(padSec, tailroom)) : endSec + Math.min(padSec, tailroom);
	return { startSec: newStart, endSec: Math.max(cappedEnd, newStart) };
}

/**
 * Pad every draft span (and every swap alternate, so a swapped-in take is padded
 * too) into its surrounding source silence. Pure: returns a new draft; the input is
 * untouched. The segment universe comes from the full candidate `pool`.
 */
export function padAssemblyDraft({
	draft,
	pool,
	padSec = DEFAULT_ASSEMBLE_PAD_SEC,
}: {
	draft: AssemblyDraft;
	pool: readonly CandidateSpan[];
	padSec?: number;
}): AssemblyDraft {
	const segsByAsset = segmentsByAsset(pool);

	const padOne = <T extends { assetId: string; sourceStartSec: number; sourceEndSec: number; sourceDurationSec: number }>(
		span: T,
	): T => {
		const segments = segsByAsset.get(span.assetId) ?? [];
		const { startSec, endSec } = padSpanIntoSilence({
			startSec: span.sourceStartSec,
			endSec: span.sourceEndSec,
			durationSec: span.sourceDurationSec,
			segments,
			padSec,
		});
		return { ...span, sourceStartSec: startSec, sourceEndSec: endSec };
	};

	const spans: DraftSpan[] = draft.spans.map(padOne);
	const alternatesByClusterId: Record<string, SpanAlternate[]> = {};
	for (const [clusterId, alts] of Object.entries(draft.alternatesByClusterId)) {
		alternatesByClusterId[clusterId] = alts.map(padOne);
	}
	return { spans, alternatesByClusterId };
}
