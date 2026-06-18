/**
 * Director frame perception (Vision v0, U1).
 *
 * Turns the Director's transcript segments into a small, capped set of sampled
 * frames the vision planner can judge. The correlation primitive is one frame
 * per segment, taken at the segment's SOURCE midpoint (via the wasm-free
 * `timelineTimeToSource`), so each frame maps 1:1 to a transcript line — the
 * model can say "segment 7 is off-screen, cut it" against the matching image.
 *
 * The selection math (`selectDirectorFrameRequests`, `pickSpread`) is pure and
 * unit-tested; `sampleDirectorFrames` is the browser shell that drives the
 * mediabunny/canvas decode in `frame-extract.ts` and is verified live.
 *
 * Scene-aware sampling (`pickSceneCandidates`) is a B-roll-cutpoint tool and is
 * deferred to a later round — the *cut* use-case wants one frame per spoken
 * segment, which is what this provides.
 */

import type {
	DirectorVisionFrame,
	MultimodalImageMediaType,
} from "@framecut/hf-bridge";
import type { MediaAsset } from "@/media/types";
import { extractFrames, type FrameSample } from "./frame-extract";
import type { TranscriptSegment } from "./build-signal-table";
import { timelineTimeToSource, type SourceMapElement } from "./source-map";

// Wasm-free local copy of `@/wasm`'s TICKS_PER_SECOND, so the selection math is
// bun-testable (matches source-map.ts / build-signal-table.ts).
const TICKS_PER_SECOND = 120_000;

/**
 * Hard cap on frames sent in one Director run. Mirrors the planner's
 * `MAX_MULTIMODAL_IMAGES`; `partitionMultimodalBlocks` enforces the real cap
 * defensively downstream, so this only has to keep the decode cheap.
 */
export const MAX_DIRECTOR_FRAMES = 20;

/** A frame to sample: which transcript segment, which asset, and where in it. */
export interface DirectorFrameRequest {
	segmentIndex: number;
	assetId: string;
	/** Time in the SOURCE asset, in seconds. */
	sourceSec: number;
}

/** A sampled frame tied back to its transcript segment. */
export interface DirectorFrame {
	segmentIndex: number;
	sourceSec: number;
	dataUrl: string;
}

/**
 * Pick at most `max` items spread evenly across `items`, always keeping the
 * first and last. With `items.length <= max` returns a copy of all of them.
 * `max <= 0` returns none. Indices are distinct (the step exceeds 1 once over
 * the cap), so no item is picked twice.
 */
export function pickSpread<T>({
	items,
	max,
}: {
	items: readonly T[];
	max: number;
}): T[] {
	if (max <= 0) return [];
	if (items.length <= max) return [...items];
	if (max === 1) return [items[0]];

	const result: T[] = [];
	const step = (items.length - 1) / (max - 1);
	for (let i = 0; i < max; i++) {
		result.push(items[Math.round(i * step)]);
	}
	return result;
}

/**
 * Map each transcript segment to a frame request at its source midpoint, then
 * cap the count with an even spread across the timeline. Segments over a gap
 * (no element under the midpoint) are dropped. Pure — the browser decode is
 * `sampleDirectorFrames`.
 */
export function selectDirectorFrameRequests({
	segments,
	elements,
	maxImages = MAX_DIRECTOR_FRAMES,
}: {
	segments: readonly TranscriptSegment[];
	elements: readonly SourceMapElement[];
	maxImages?: number;
}): DirectorFrameRequest[] {
	const requests: DirectorFrameRequest[] = [];
	segments.forEach((seg, segmentIndex) => {
		const midSec = (seg.start + seg.end) / 2;
		const located = timelineTimeToSource({
			timelineTicks: Math.round(midSec * TICKS_PER_SECOND),
			elements,
		});
		if (located) {
			requests.push({
				segmentIndex,
				assetId: located.assetId,
				sourceSec: located.sourceSec,
			});
		}
	});
	return pickSpread({ items: requests, max: maxImages });
}

/**
 * Decode one frame per selected segment and tie it back to that segment.
 * Groups requests by source asset (one decode pass per asset), then restores
 * segment order so the frames interleave naturally with the transcript.
 *
 * Browser-only (WebCodecs + canvas). Frames are returned in segment order;
 * `frame-extract` preserves request order and only drops a frame when a decode
 * yields no sample (rare for an in-range time), so the per-asset index zip is
 * exact in practice.
 */
export async function sampleDirectorFrames({
	segments,
	elements,
	assets,
	maxImages = MAX_DIRECTOR_FRAMES,
	signal,
}: {
	segments: readonly TranscriptSegment[];
	elements: readonly SourceMapElement[];
	assets: readonly MediaAsset[];
	maxImages?: number;
	signal?: AbortSignal;
}): Promise<DirectorFrame[]> {
	const requests = selectDirectorFrameRequests({ segments, elements, maxImages });

	const byAsset = new Map<string, DirectorFrameRequest[]>();
	for (const req of requests) {
		const list = byAsset.get(req.assetId);
		if (list) {
			list.push(req);
		} else {
			byAsset.set(req.assetId, [req]);
		}
	}

	const frames: DirectorFrame[] = [];
	for (const [assetId, reqs] of byAsset) {
		const asset = assets.find((candidate) => candidate.id === assetId);
		if (!asset) continue;
		const extracted: FrameSample[] = await extractFrames({
			asset,
			timesSec: reqs.map((req) => req.sourceSec),
			signal,
		});
		extracted.forEach((frame, i) => {
			const req = reqs[i];
			if (req) {
				frames.push({
					segmentIndex: req.segmentIndex,
					sourceSec: frame.timeSec,
					dataUrl: frame.dataUrl,
				});
			}
		});
	}

	frames.sort((a, b) => a.segmentIndex - b.segmentIndex);
	return frames;
}

/** A user-facing notice after a (possibly attempted) vision run. */
export interface VisionNotice {
	kind: "info" | "warning" | "none";
	message: string;
}

/**
 * Decide what to tell the user after a Director run (cost transparency + the
 * degrade path, R4/R3). No frames → nothing to say. Frames sent but the backend
 * couldn't take them (`degraded`) → a warning that it fell back to the transcript.
 * Frames analyzed → an info line with the frame count and (when known) the token
 * cost. Pure, so the branch is unit-tested; the caller dispatches the toast.
 */
export function formatVisionNotice({
	frameCount,
	degraded,
	inputTokens,
}: {
	frameCount: number;
	degraded: boolean;
	inputTokens?: number | null;
}): VisionNotice {
	if (frameCount <= 0) {
		return { kind: "none", message: "" };
	}
	if (degraded) {
		return {
			kind: "warning",
			message:
				"Director vision isn't available on this connection — used the transcript instead. Add an API key (Settings → AI) for visual cuts.",
		};
	}
	const tokenNote =
		typeof inputTokens === "number" && inputTokens > 0
			? ` · ~${Math.round(inputTokens / 1000)}k tokens`
			: "";
	const plural = frameCount === 1 ? "" : "s";
	return {
		kind: "info",
		message: `Director vision analyzed ${frameCount} frame${plural}${tokenNote}.`,
	};
}

/** Accepted base64 image data-URL: `data:image/<jpeg|png|gif|webp>;base64,<data>`. */
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/;

/** Type-predicate guard (no `as` narrowing) for an accepted image media type. */
function isImageMediaType(value: string): value is MultimodalImageMediaType {
	return (
		value === "image/jpeg" ||
		value === "image/png" ||
		value === "image/gif" ||
		value === "image/webp"
	);
}

/**
 * Convert sampled frames into the planner's wire shape (segment-tagged base64,
 * no `data:` prefix), dropping any frame whose data URL can't be parsed. Pure —
 * the route forwards these straight to `planDirectorVision`.
 */
export function toVisionFrames(
	frames: readonly DirectorFrame[],
): DirectorVisionFrame[] {
	const out: DirectorVisionFrame[] = [];
	for (const frame of frames) {
		const match = DATA_URL_RE.exec(frame.dataUrl);
		if (!match) continue;
		const mediaType = match[1];
		const dataBase64 = match[2];
		if (!isImageMediaType(mediaType)) continue;
		out.push({ segmentIndex: frame.segmentIndex, mediaType, dataBase64 });
	}
	return out;
}
