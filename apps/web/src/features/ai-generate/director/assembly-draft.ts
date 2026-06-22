/**
 * The editable draft behind the assembly REVIEW panel (FrameCut auto-assemble,
 * P5). The draft is an ORDERED list of spans; `dropped` is a flag (not a delete)
 * so a dropped span can be brought back. The current (floating) timeline position
 * of each active span falls out of a running sum — `placedSpans` is BOTH the
 * order-to-timeline projection AND the original→current timecode mapping the panel
 * shows per row. All transforms are pure (immutable) → bun-testable; the panel
 * keeps an undo/redo history of drafts so each edit is individually reversible.
 */

import type { AssemblySpanInput } from "./assembly-placement";

/** One span in the draft. Source in/out are the IMMUTABLE original timecodes. */
export interface DraftSpan {
	id: string;
	assetId: string;
	clipName: string;
	sourceStartSec: number;
	sourceEndSec: number;
	/** Full source-clip duration (for trimEnd on placement). */
	sourceDurationSec: number;
	text?: string;
	/** Take-cluster id, when this span has alternate takes to swap to. */
	clusterId?: string;
	dropped: boolean;
}

/** A span with its computed CURRENT (floating) position on the assembled timeline. */
export interface PlacedDraftSpan extends DraftSpan {
	currentStartSec: number;
	currentEndSec: number;
}

/** An alternate take a span can be swapped to (a sibling in its take cluster). */
export interface SpanAlternate {
	assetId: string;
	clipName: string;
	sourceStartSec: number;
	sourceEndSec: number;
	sourceDurationSec: number;
	text?: string;
}

/** The spans currently IN the cut, in order. */
export function activeSpans(spans: readonly DraftSpan[]): DraftSpan[] {
	return spans.filter((span) => !span.dropped);
}

/**
 * Project the active spans onto the timeline: each lands at the running sum of
 * the prior active spans' source-span lengths. The returned `currentStartSec`/
 * `currentEndSec` is the floating position that shifts as spans are dropped /
 * re-included / swapped — i.e. the original→current mapping, keyed by span id.
 */
export function placedSpans(spans: readonly DraftSpan[]): PlacedDraftSpan[] {
	const placed: PlacedDraftSpan[] = [];
	let cursorSec = 0;
	for (const span of spans) {
		if (span.dropped) continue;
		const lengthSec = Math.max(0, span.sourceEndSec - span.sourceStartSec);
		placed.push({
			...span,
			currentStartSec: cursorSec,
			currentEndSec: cursorSec + lengthSec,
		});
		cursorSec += lengthSec;
	}
	return placed;
}

/** Drop a span from the cut (kept in the list so it can be re-included). */
export function dropSpan({
	spans,
	id,
}: {
	spans: readonly DraftSpan[];
	id: string;
}): DraftSpan[] {
	return spans.map((span) =>
		span.id === id ? { ...span, dropped: true } : span,
	);
}

/** Bring a dropped span back into the cut at its original ordinal. */
export function includeSpan({
	spans,
	id,
}: {
	spans: readonly DraftSpan[];
	id: string;
}): DraftSpan[] {
	return spans.map((span) =>
		span.id === id ? { ...span, dropped: false } : span,
	);
}

/**
 * Swap a span to a different take of the same line (an alternate from its take
 * cluster): the source in/out + clip + text change, but the span keeps its id and
 * its ordinal in the cut.
 */
export function swapSpan({
	spans,
	id,
	alternate,
}: {
	spans: readonly DraftSpan[];
	id: string;
	alternate: SpanAlternate;
}): DraftSpan[] {
	return spans.map((span) =>
		span.id === id
			? {
					...span,
					assetId: alternate.assetId,
					clipName: alternate.clipName,
					sourceStartSec: alternate.sourceStartSec,
					sourceEndSec: alternate.sourceEndSec,
					sourceDurationSec: alternate.sourceDurationSec,
					...(alternate.text !== undefined ? { text: alternate.text } : {}),
				}
			: span,
	);
}

/** Turn the placed (active, ordered) spans into placement inputs for the rebuild. */
export function draftToPlacementInputs(
	spans: readonly DraftSpan[],
): AssemblySpanInput[] {
	return placedSpans(spans).map((span) => ({
		mediaId: span.assetId,
		name: span.clipName,
		sourceStartSec: span.sourceStartSec,
		sourceEndSec: span.sourceEndSec,
		sourceDurationSec: span.sourceDurationSec,
	}));
}
