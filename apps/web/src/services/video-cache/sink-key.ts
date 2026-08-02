/**
 * T19.3: pure sink-key arithmetic for the video cache (wasm-free, bun-testable
 * without a decoder), in the same spirit as `seek-supersede.ts`.
 *
 * The cache has always kept exactly ONE decode sink per mediaId. That is right
 * for the normal timeline - N clips cut from one file are almost never on
 * screen at the same instant, so they share a sink and a decode budget. A
 * crossDissolve between two clips SPLIT FROM ONE FILE breaks that assumption:
 * both sides want a different source time on the same frame, so every
 * getFrameAt supersedes the other side's queued decode and the sink is torn
 * down and re-seeked twice per frame (the ~600ms same-file stall class
 * documented in `boundary-prefetch.ts`).
 *
 * The fix is PER-CONSUMER SINK KEYING: a clip may ask for its own sink by
 * passing a `consumerId`. Only the clips that actually need one ask (the scene
 * builder sets it on the right side of a same-source crossDissolve), and the
 * extra sinks live on a small shared budget with LRU eviction, so the memory
 * cost stays bounded no matter how many transitions a project has.
 */

export const SINK_KEY_SEPARATOR = "::";

/**
 * How many secondary (consumer-keyed) sinks may exist at once, across all
 * media. Each one is a mediabunny Input + CanvasSink with a 3-frame pool, so
 * this is the "shared decode budget" - generous enough for several transitions
 * in flight, small enough that a 200-cut project cannot balloon.
 */
export const MAX_SECONDARY_SINKS = 4;

export function buildSinkKey({
	mediaId,
	consumerId,
}: {
	mediaId: string;
	consumerId?: string;
}): string {
	if (!consumerId) return mediaId;
	return `${mediaId}${SINK_KEY_SEPARATOR}${consumerId}`;
}

export function isSecondarySinkKey({ key }: { key: string }): boolean {
	return key.includes(SINK_KEY_SEPARATOR);
}

export function mediaIdFromSinkKey({ key }: { key: string }): string {
	const index = key.indexOf(SINK_KEY_SEPARATOR);
	return index === -1 ? key : key.slice(0, index);
}

/**
 * Which secondary sinks to drop, given their keys in LEAST-recently-used-first
 * order and the budget. Primary (unkeyed) sinks are never candidates - they
 * keep the pre-T19.3 lifetime exactly.
 */
export function selectSecondarySinksToEvict({
	lruKeys,
	budget = MAX_SECONDARY_SINKS,
}: {
	lruKeys: readonly string[];
	budget?: number;
}): string[] {
	const overflow = lruKeys.length - budget;
	if (overflow <= 0) return [];
	return lruKeys.slice(0, overflow);
}
