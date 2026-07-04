/**
 * Client side of export compositing: collects FrameCut AI overlay clips from
 * scene tracks and asks the local ffmpeg route to burn them onto a base
 * render (the canvas pipeline can't decode their alpha — see
 * overlay-preview-layer.tsx).
 */

import type { SceneTracks, VideoElement } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { computeOverlayRect } from "@/features/ai-generate/overlay-rect";

export function collectAiOverlayClips({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): VideoElement[] {
	const out: VideoElement[] = [];
	for (const track of tracks.overlay) {
		if (track.type !== "video" || track.hidden) continue;
		for (const element of track.elements) {
			if (element.type !== "video" || element.hidden) continue;
			const asset = mediaAssets.find((a) => a.id === element.mediaId);
			if (element.framecutAi || asset?.hasAlpha) {
				out.push(element);
			}
		}
	}
	return out;
}

/**
 * Returns the composited buffer (mp4) when AI overlays exist, or the
 * original buffer untouched when there are none.
 */
export async function compositeAiOverlays({
	baseBuffer,
	baseName,
	tracks,
	mediaAssets,
	canvasSize,
}: {
	baseBuffer: ArrayBuffer;
	baseName: string;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	canvasSize: { width: number; height: number };
}): Promise<{ buffer: ArrayBuffer; composited: boolean }> {
	const clips = collectAiOverlayClips({ tracks, mediaAssets });
	if (!clips.length) {
		return { buffer: baseBuffer, composited: false };
	}

	const form = new FormData();
	form.append("base", new File([baseBuffer], baseName));
	const manifest: {
		field: string;
		startSec: number;
		durationSec: number;
		trimStartSec: number;
		/** Rendered rect in canvas pixels (matches the preview/compositor).
		 *  x/y is the top-left of the ROTATED bbox when rotation != 0. */
		x: number;
		y: number;
		w: number;
		h: number;
		opacity: number;
		rotation: number;
		flipX: boolean;
		flipY: boolean;
	}[] = [];
	let index = 0;
	for (const clip of clips) {
		const asset = mediaAssets.find((a) => a.id === clip.mediaId);
		if (!asset?.file) continue;
		const field = `overlay_${index}`;
		form.append(field, asset.file);
		// Same contain-fit + transform math the preview and compositor use, so
		// the burned-in overlay lands exactly where it shows in the preview.
		const rect = computeOverlayRect({
			params: clip.params,
			animations: clip.animations,
			localTimeTicks: 0,
			mediaW: asset.width ?? 0,
			mediaH: asset.height ?? 0,
			canvasW: canvasSize.width,
			canvasH: canvasSize.height,
		});
		// ffmpeg rotate expands the frame to the rotated bbox; offset the
		// top-left so the element CENTER stays where the preview puts it.
		const cx = rect.x + rect.w / 2;
		const cy = rect.y + rect.h / 2;
		let x = rect.x;
		let y = rect.y;
		if (rect.rotation % 360 !== 0) {
			const rad = (rect.rotation * Math.PI) / 180;
			const rw =
				Math.abs(rect.w * Math.cos(rad)) + Math.abs(rect.h * Math.sin(rad));
			const rh =
				Math.abs(rect.w * Math.sin(rad)) + Math.abs(rect.h * Math.cos(rad));
			x = cx - rw / 2;
			y = cy - rh / 2;
		}
		manifest.push({
			field,
			startSec: clip.startTime / TICKS_PER_SECOND,
			durationSec: clip.duration / TICKS_PER_SECOND,
			trimStartSec: clip.trimStart / TICKS_PER_SECOND,
			x: Math.round(x),
			y: Math.round(y),
			w: Math.max(2, Math.round(rect.w)),
			h: Math.max(2, Math.round(rect.h)),
			opacity: rect.opacity,
			rotation: rect.rotation,
			flipX: rect.flipX,
			flipY: rect.flipY,
		});
		index += 1;
	}
	if (!manifest.length) {
		return { buffer: baseBuffer, composited: false };
	}
	form.append("manifest", JSON.stringify(manifest));

	const res = await fetch("/api/media/composite", { method: "POST", body: form });
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Composite failed (${res.status})`);
	}
	return { buffer: await res.arrayBuffer(), composited: true };
}
