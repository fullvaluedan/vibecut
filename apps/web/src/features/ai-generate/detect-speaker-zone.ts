/**
 * Browser shell for speaker-aware HyperFrames placement.
 *
 * Samples a few frames across a clip's source span, asks the vision route which
 * horizontal third(s) the speaker occupies in each (they may move), and returns a
 * movement-aware safe-zone instruction to drop into the authoring brief. Gated by
 * the caller on the Director Vision toggle. Best-effort: any failure (vision off,
 * degraded backend, decode/network error) returns null and the brief falls back to
 * its robust lower-third default — speaker safety never depends on this succeeding.
 */

import type { SafeZone } from "@framecut/hf-bridge";
import { extractFrames } from "./director/frame-extract";
import { buildAiAuthHeaders } from "./store";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditorCore } from "@/core";
import type { VideoElement } from "@/timeline";

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/;

export async function detectSpeakerZone({
	editor,
	element,
	signal,
}: {
	editor: EditorCore;
	element: VideoElement;
	signal?: AbortSignal;
}): Promise<string | null> {
	try {
		const asset = editor.media
			.getAssets()
			.find((a) => a.id === element.mediaId);
		if (!asset || asset.type !== "video") return null;

		const trimStartSec = element.trimStart / TICKS_PER_SECOND;
		const durSec = element.duration / TICKS_PER_SECOND;
		if (durSec <= 0) return null;
		// Three frames across the clip (skip the very edges where cuts sit).
		const timesSec = [0.15, 0.5, 0.85].map((f) => trimStartSec + f * durSec);

		const frames = await extractFrames({ asset, timesSec, signal });
		const wire = frames
			.map((fr) => {
				const m = DATA_URL_RE.exec(fr.dataUrl);
				return m ? { mediaType: m[1], dataBase64: m[2] } : null;
			})
			.filter((f): f is { mediaType: string; dataBase64: string } => f !== null);
		if (!wire.length) return null;

		const res = await fetch("/api/hyperframes/speaker-zone", {
			method: "POST",
			headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
			body: JSON.stringify({ frames: wire }),
			signal,
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			safeZone: SafeZone | null;
			degraded: boolean;
		};
		return data.safeZone?.instruction ?? null;
	} catch {
		return null; // robust default takes over
	}
}
