/**
 * Fuse the Phase-A senses into the Director planner's per-segment signal table (U5).
 *
 * Each transcript segment is enriched with its audio features (energy / loudness /
 * wpm / filler, parallel from `computeSpeechFeatures`), the source asset under it
 * (via `timelineTimeToSource` — for take comparison), and the silence gap before
 * it (the inter-segment transcript gap). Pure and wasm-free (a local ticks const)
 * so it is unit-testable; the orchestrator decodes the audio and runs the senses.
 */

import { timelineTimeToSource, type SourceMapElement } from "./source-map";
import type { SpeechFeatures } from "./types";
import type { DirectorSegment } from "@framecut/hf-bridge";

// Wasm-free local copy of `@/wasm`'s TICKS_PER_SECOND, so this module is
// bun-testable (matches source-map.ts / the trim-tools precedent).
const TICKS_PER_SECOND = 120_000;
/** Silence shorter than this (seconds) is breath, not a gap worth flagging. */
const MIN_SILENCE_SEC = 0.05;

/** A transcript segment in timeline seconds, as produced by the timeline transcriber. */
export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

/**
 * Zip transcript + features (parallel arrays) into `DirectorSegment[]`, mapping
 * each segment's midpoint to its source asset and computing the silence before it.
 */
export function buildSignalTable({
	segments,
	features,
	elements,
	clusterIds,
	importance,
}: {
	segments: readonly TranscriptSegment[];
	/** Parallel to `segments` (one per segment), as returned by computeSpeechFeatures. */
	features: readonly SpeechFeatures[];
	/** Main-track elements, for source mapping. */
	elements: readonly SourceMapElement[];
	/** Take-cluster id per segment, keyed by start second (3-decimal). Absent → no grp column. */
	clusterIds?: ReadonlyMap<number, string>;
	/** Importance score per segment (parallel to `segments`). Absent → no imp column. */
	importance?: readonly number[];
}): DirectorSegment[] {
	return segments.map((seg, i) => {
		const f = features[i];
		const midSec = (seg.start + seg.end) / 2;
		const located = timelineTimeToSource({
			timelineTicks: Math.round(midSec * TICKS_PER_SECOND),
			elements,
		});
		const prevEnd = i > 0 ? segments[i - 1].end : 0;
		const silenceBeforeSec = Math.max(0, seg.start - prevEnd);
		const clusterId = clusterIds?.get(Math.round(seg.start * 1000) / 1000);
		const imp = importance?.[i];

		return {
			startSec: seg.start,
			endSec: seg.end,
			text: seg.text,
			...(located ? { assetId: located.assetId } : {}),
			...(f
				? {
						energy: f.energy,
						loudnessRelative: f.loudnessRelative,
						wpm: f.wpm,
						fillerCandidate: f.fillerCandidate,
					}
				: {}),
			...(silenceBeforeSec > MIN_SILENCE_SEC ? { silenceBeforeSec } : {}),
			...(clusterId ? { clusterId } : {}),
			...(imp !== undefined ? { importance: imp } : {}),
		};
	});
}
