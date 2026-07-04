/**
 * Build the per-line catalog the LLM redundancy pass reasons over (the input to
 * `buildRedundancyPrompt`). Each transcript segment becomes a `RedundancyLine` in
 * TIMELINE coordinates (the coordinate the cut removes), enriched with its source
 * clip name and the audio-feature signals (loudness / wpm / filler) the bin already
 * computed, so the LLM can judge the best-delivered take (KTD-2/R4).
 *
 * Pure + wasm-free (a local ticks const + the wasm-free `timelineTimeToSource`), so
 * it is unit-testable; the orchestrator (run-director) decodes audio + runs the
 * senses. The `RedundancyLine` type is a type-only import from hf-bridge (erased at
 * runtime — mirrors `build-signal-table.ts`'s `DirectorSegment` import).
 */

import { timelineTimeToSource, type SourceMapElement } from "./source-map";
import type { SpeechFeatures } from "./types";
import type { RedundancyLine } from "@framecut/hf-bridge";

// Wasm-free local copy of `@/wasm`'s TICKS_PER_SECOND (matches source-map.ts /
// build-signal-table.ts), so this module is bun-testable.
const TICKS_PER_SECOND = 120_000;

/** A transcript segment in timeline seconds, as produced by the timeline transcriber. */
export interface CatalogSegment {
	start: number;
	end: number;
	text: string;
}

/**
 * Zip transcript + features (parallel arrays) into `RedundancyLine[]`. Line ids are
 * INDEX-based (`L0`, `L1`, …) so two segments sharing a rounded start-second still
 * get distinct ids (a start-based id would collide and cut the wrong span). The
 * source clip name comes from the asset under each segment's midpoint; it is omitted
 * over a gap or for an unmapped asset (no `undefined` leak). Feature fields are
 * omitted when the parallel feature is absent (degrade to transcript-only keeper).
 */
export function buildRedundancyCatalog({
	segments,
	features,
	elements,
	clipNameByAssetId,
}: {
	segments: readonly CatalogSegment[];
	/** Parallel to `segments` (one per segment), as returned by computeSpeechFeatures. */
	features: readonly SpeechFeatures[];
	/** Main-track elements, for source-clip attribution. */
	elements: readonly SourceMapElement[];
	/** assetId → display clip name. */
	clipNameByAssetId: ReadonlyMap<string, string>;
}): RedundancyLine[] {
	return segments.map((seg, i) => {
		const midSec = (seg.start + seg.end) / 2;
		const located = timelineTimeToSource({
			timelineTicks: Math.round(midSec * TICKS_PER_SECOND),
			elements,
		});
		const clipName = located ? clipNameByAssetId.get(located.assetId) : undefined;
		const f = features[i];

		return {
			lineId: `L${i}`,
			startSec: seg.start,
			endSec: seg.end,
			text: seg.text,
			...(clipName !== undefined ? { clipName } : {}),
			...(f
				? {
						loudnessRelative: f.loudnessRelative,
						wpm: f.wpm,
						fillerCandidate: f.fillerCandidate,
					}
				: {}),
		};
	});
}
