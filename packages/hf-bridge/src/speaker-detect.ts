/**
 * Vision detection of the speaker's location for HyperFrames placement.
 *
 * Given frames sampled across one clip (browser-side, by the director frame
 * sampler), ask a vision model which horizontal third(s) the speaker occupies in
 * EACH frame, then reduce to a movement-proof safe zone via `computeSafeZone`.
 * Reuses `planMultimodal`, so it inherits the api-key / custom image path and the
 * claude-code degrade (no vision) — which returns `null` here so the caller falls
 * back to the lower-third default. The JSON-parse + reduce is unit-tested; the
 * live model call is exercised by the route.
 */

import {
	planMultimodal,
	type MultimodalBlock,
	type MultimodalImageMediaType,
} from "./author";
import {
	computeSafeZone,
	type FrameSpeaker,
	type HZone,
	type SafeZone,
} from "./speaker-zone";
import type { ClaudeAuth } from "./types";

/** One sampled frame to classify (base64, no data: prefix). */
export interface SpeakerDetectFrame {
	mediaType: MultimodalImageMediaType;
	dataBase64: string;
}

const HZONES: readonly HZone[] = ["left", "center", "right"];

/** JSON schema: one {occupies:[...]} entry per image, in order. */
const ZONE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		frames: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					occupies: {
						type: "array",
						items: { type: "string", enum: ["left", "center", "right"] },
					},
				},
				required: ["occupies"],
			},
		},
	},
	required: ["frames"],
} as const;

/** Keep only valid, de-duped zone strings from a model-returned array. */
export function sanitizeOccupies(value: unknown): HZone[] {
	if (!Array.isArray(value)) return [];
	const out: HZone[] = [];
	for (const z of value) {
		if (typeof z === "string" && HZONES.includes(z as HZone) && !out.includes(z as HZone)) {
			out.push(z as HZone);
		}
	}
	return out;
}

/** Reduce a model response (`{frames:[{occupies}]}`) to a SafeZone. Pure. */
export function safeZoneFromModelFrames(raw: unknown): SafeZone {
	const frames = (raw as { frames?: { occupies?: unknown }[] } | null)?.frames;
	const perFrame: FrameSpeaker[] = Array.isArray(frames)
		? frames.map((f, i) => ({ timeSec: i, occupies: sanitizeOccupies(f?.occupies) }))
		: [];
	return computeSafeZone(perFrame);
}

/**
 * Classify the speaker's column per frame and reduce to a movement-proof safe
 * zone. Returns `null` when the backend can't take images (claude-code) so the
 * caller uses the lower-third default; an empty frame list yields the
 * "unknown → band" zone.
 */
export async function detectSpeakerZonesFromFrames({
	frames,
	auth,
	signal,
}: {
	frames: readonly SpeakerDetectFrame[];
	auth: ClaudeAuth;
	signal?: AbortSignal;
}): Promise<SafeZone | null> {
	if (!frames.length) return computeSafeZone([]);

	const prompt = `These ${frames.length} images are evenly-spaced frames from ONE short talking-head video clip, in time order. For EACH frame, report which horizontal THIRD(s) of the frame the main speaker (their head and torso) occupies: "left" = x 0-33%, "center" = 33-67%, "right" = 67-100%. If the speaker straddles a boundary, include BOTH thirds. Return {"frames":[{"occupies":[...]}, ...]} with EXACTLY one entry per image, in the same order.`;

	const blocks: MultimodalBlock[] = [
		{ type: "text", text: prompt },
		...frames.map(
			(f): MultimodalBlock => ({
				type: "image",
				mediaType: f.mediaType,
				dataBase64: f.dataBase64,
			}),
		),
	];

	const result = await planMultimodal({ blocks, auth, schema: ZONE_SCHEMA, signal });
	if (result.degraded) return null;
	return safeZoneFromModelFrames(result.raw);
}
