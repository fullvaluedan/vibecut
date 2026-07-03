/**
 * Pure decision for the playback boundary prefetch (wasm-free, bun-testable).
 *
 * Playback drops ticks with a ~600ms freeze whenever the playhead crosses a cut
 * boundary into a clip whose decode sink is cold: the frame-cache fast-path
 * misses and a cold deep seek into the long (32-min) source blows the frame
 * budget, so the preview render loop drops the next tick. The cure (KTD8) is to
 * warm the NEXT clip's boundary frame just BEFORE the playhead crosses, off the
 * critical frame path, so the crossing hits the fast-path instead of a cold seek.
 *
 * This module only DECIDES what to warm; the decode itself stays in the service
 * layer (`videoCache.prefetchFrameAt`). It works in seconds and imports no wasm
 * so it stays unit-testable without a real decoder.
 */

/**
 * How close (seconds) the playhead must be to the current clip's end before we
 * warm the next boundary. Big enough to cover a cold sink open + first decode
 * (the ~600ms stall), small enough not to warm sinks the playhead may never reach.
 */
export const DEFAULT_PREFETCH_LOOKAHEAD_SEC = 0.5;

/** A main-track clip as the prefetch decision needs to see it (all in seconds). */
export interface PrefetchClip {
	/** Source media the clip decodes from (the video-cache sink key). */
	mediaId: string;
	/** Timeline span of the clip. */
	startSec: number;
	endSec: number;
	/** Source time of the clip's first frame (its trimStart), what we warm. */
	sourceStartSec: number;
}

export interface BoundaryPrefetchTarget {
	mediaId: string;
	sourceTimeSec: number;
}

/** A video element on another lane (overlay/PiP) that shares the per-mediaId sinks. */
export interface ActiveMediaSpan {
	mediaId: string;
	startSec: number;
	endSec: number;
}

/** True when the playhead sits within `lookaheadSec` before the clip's end. */
export function isWithinBoundaryLookahead({
	playheadSec,
	currentClipEndSec,
	lookaheadSec,
}: {
	playheadSec: number;
	currentClipEndSec: number;
	lookaheadSec: number;
}): boolean {
	const remaining = currentClipEndSec - playheadSec;
	return remaining > 0 && remaining <= lookaheadSec;
}

/**
 * Index of the clip whose `[startSec, endSec)` span contains the playhead, or
 * -1 when the playhead sits in a gap / past the last clip.
 */
export function findActiveClipIndex({
	clips,
	playheadSec,
}: {
	clips: readonly PrefetchClip[];
	playheadSec: number;
}): number {
	return clips.findIndex(
		(clip) => playheadSec >= clip.startSec && playheadSec < clip.endSec,
	);
}

/**
 * Decide whether to warm the next cut boundary now, and which source frame to
 * warm. Returns null (nothing to warm) when: there is no active clip, no next
 * clip (last clip), the playhead is outside the lookahead window, or the next
 * clip is a same-source continuation.
 *
 * A same-source next clip (`next.mediaId === current.mediaId`) shares the ONE
 * decode sink keyed by that mediaId. It is already warm from the clip currently
 * playing, and re-seeking that shared sink to the boundary would corrupt the
 * frame being shown right now, so it is deliberately skipped (safe, and the
 * common continuation case needs no warm anyway).
 *
 * `clips` MUST be sorted by `startSec` so `clips[activeIndex + 1]` is the next
 * clip to play.
 */
export function resolveBoundaryPrefetch({
	clips,
	playheadSec,
	lookaheadSec = DEFAULT_PREFETCH_LOOKAHEAD_SEC,
	overlaySpans = [],
}: {
	clips: readonly PrefetchClip[];
	playheadSec: number;
	lookaheadSec?: number;
	/** Video elements on OTHER lanes (overlay/PiP); a prefetch never touches media
	 * one of them is decoding now or inside the lookahead window (review F8). */
	overlaySpans?: readonly ActiveMediaSpan[];
}): BoundaryPrefetchTarget | null {
	const activeIndex = findActiveClipIndex({ clips, playheadSec });
	if (activeIndex < 0) return null;

	const current = clips[activeIndex];
	const next = clips[activeIndex + 1];
	if (!next) return null;

	if (
		!isWithinBoundaryLookahead({
			playheadSec,
			currentClipEndSec: current.endSec,
			lookaheadSec,
		})
	) {
		return null;
	}

	if (next.mediaId === current.mediaId) return null;

	// Decode sinks are shared per mediaId across EVERY render node, overlays and
	// PiP included. Warming the next clip's media while an overlay is actively
	// decoding it would cold-seek that shared sink mid-playback: the overlay
	// stutters and its next read evicts the warmed frame anyway, so the crossing
	// stays cold too. Skip when any overlay span using that media is live now or
	// becomes live inside the lookahead window.
	const overlayBusy = overlaySpans.some(
		(o) =>
			o.mediaId === next.mediaId &&
			o.startSec < playheadSec + lookaheadSec &&
			playheadSec < o.endSec,
	);
	if (overlayBusy) return null;

	return { mediaId: next.mediaId, sourceTimeSec: next.sourceStartSec };
}
