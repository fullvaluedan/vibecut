/**
 * The read-only view model behind the deleted-words window (T16.2 point 2): the
 * struck words, what the cut was, and where it sat in the ORIGINAL recording.
 *
 * Timecodes are in the lineage's SOURCE coordinates on purpose - the whole point
 * of the window is "here is what used to be here", and source time is the only
 * frame of reference in which the removed content still has a position.
 *
 * Pure and wasm-free (a local ticks-per-second copy, same precedent as
 * lineage.ts) so it is unit-testable on plain numbers.
 */

import { formatTimestamp } from "./format-transcript-text";
import type { LineageSeam } from "./lineage-types";

const TICKS_PER_SECOND = 120_000;

/** One provenance row in the window. */
export interface SeamProvenanceLine {
	/** "AI Director - filler", "Manual delete", ... */
	label: string;
	/** The Director's own reason string, when there is one. */
	detail?: string;
	/** `mm:ss.s - mm:ss.s` in SOURCE coordinates. */
	timecode: string;
}

/** Everything the window renders for one seam. */
export interface SeamWindowModel {
	seamId: string;
	/** The removed words, in order, for the strikethrough list. */
	words: string[];
	/** One entry per merged removal span this pipe collapses (T16.1 note 5). */
	spans: string[];
	provenance: SeamProvenanceLine[];
	/** "2.4s removed". */
	removedLabel: string;
}

const range = ({ startSec, endSec }: { startSec: number; endSec: number }): string =>
	`${formatTimestamp(startSec)} - ${formatTimestamp(endSec)}`;

export function describeSeam({ seam }: { seam: LineageSeam }): SeamWindowModel {
	const spans = seam.removedSpans.map(range);
	const spansLabel = spans.join(", ");

	const provenance: SeamProvenanceLine[] = [];
	for (const contribution of seam.contributions) {
		if (contribution.source === "director") {
			if (contribution.ops.length === 0) {
				provenance.push({ label: "AI Director", timecode: spansLabel });
				continue;
			}
			for (const op of contribution.ops) {
				provenance.push({
					label: op.category ? `AI Director - ${op.category}` : "AI Director",
					detail: op.reason,
					timecode: range({
						startSec: op.start / TICKS_PER_SECOND,
						endSec: op.end / TICKS_PER_SECOND,
					}),
				});
			}
			continue;
		}
		provenance.push({
			label:
				contribution.source === "manual-transcript"
					? "Manual delete"
					: "Timeline edit",
			timecode: spansLabel,
		});
	}
	// A seam whose journal entries were dropped (an evicted record, a hand-written
	// fixture) still deserves an honest header rather than an empty panel.
	if (provenance.length === 0) {
		provenance.push({ label: "Cut", timecode: spansLabel });
	}

	return {
		seamId: seam.id,
		words: seam.removedWords.map((word) => word.text),
		spans,
		provenance,
		removedLabel: `${seam.removedSec.toFixed(1)}s removed`,
	};
}
