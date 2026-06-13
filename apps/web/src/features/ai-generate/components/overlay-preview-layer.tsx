"use client";

/**
 * Renders FrameCut AI overlay clips (alpha WebMs) over the preview canvas
 * using <video> elements. The browser's media stack decodes VP9 alpha
 * correctly, unlike the WebCodecs path the canvas compositor uses — those
 * clips are excluded from the render tree (see scene-builder.ts) and shown
 * here instead. Each <video> is positioned to match the compositor's
 * transform exactly (contain-fit + scale + position, see overlay-rect.ts), so
 * the preview matches the export. The mount div is sized to the canvas rect in
 * display px, so canvas-pixel rects map to it as simple percentages.
 */

import { useEffect, useMemo, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { TICKS_PER_SECOND } from "@/wasm";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValues } from "@/params";
import type { VideoElement } from "@/timeline";
import { computeOverlayRect } from "@/features/ai-generate/overlay-rect";

interface AiOverlayClip {
	id: string;
	url: string;
	startSec: number;
	endSec: number;
	startTimeTicks: number;
	trimStartSec: number;
	hidden: boolean;
	params: ParamValues;
	animations: ElementAnimations | undefined;
	mediaW: number;
	mediaH: number;
}

const SYNC_TOLERANCE_SEC = 0.08;

export function AiOverlayPreviewLayer() {
	const editor = useEditor();
	const tracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const videoRefs = useRef(new Map<string, HTMLVideoElement>());

	const clips = useMemo<AiOverlayClip[]>(() => {
		const out: AiOverlayClip[] = [];
		for (const track of tracks.overlay) {
			if (track.type !== "video") continue;
			for (const element of track.elements) {
				if (element.type !== "video") continue;
				const video = element as VideoElement;
				const asset = mediaAssets.find((a) => a.id === video.mediaId);
				if (!asset?.url) continue;
				if (!video.framecutAi && !asset.hasAlpha) continue;
				out.push({
					id: video.id,
					url: asset.url,
					startSec: video.startTime / TICKS_PER_SECOND,
					endSec: (video.startTime + video.duration) / TICKS_PER_SECOND,
					startTimeTicks: video.startTime,
					trimStartSec: video.trimStart / TICKS_PER_SECOND,
					hidden: !!video.hidden || !!track.hidden,
					params: video.params,
					animations: video.animations,
					mediaW: asset.width ?? 0,
					mediaH: asset.height ?? 0,
				});
			}
		}
		return out;
	}, [tracks, mediaAssets]);

	useEffect(() => {
		const sync = () => {
			const nowTicks = editor.playback.getCurrentTime();
			const tSec = nowTicks / TICKS_PER_SECOND;
			const isPlaying = editor.playback.getIsPlaying();
			const canvas = editor.project.getActive()?.settings.canvasSize;
			for (const clip of clips) {
				const video = videoRefs.current.get(clip.id);
				if (!video) continue;
				const within =
					!clip.hidden && tSec >= clip.startSec && tSec < clip.endSec;
				video.style.visibility = within ? "visible" : "hidden";
				if (!within) {
					if (!video.paused) video.pause();
					continue;
				}
				// Position to match the compositor (contain-fit + transform).
				if (canvas && canvas.width > 0 && canvas.height > 0) {
					const rect = computeOverlayRect({
						params: clip.params,
						animations: clip.animations,
						localTimeTicks: Math.max(0, nowTicks - clip.startTimeTicks),
						mediaW: clip.mediaW,
						mediaH: clip.mediaH,
						canvasW: canvas.width,
						canvasH: canvas.height,
					});
					video.style.left = `${(rect.x / canvas.width) * 100}%`;
					video.style.top = `${(rect.y / canvas.height) * 100}%`;
					video.style.width = `${(rect.w / canvas.width) * 100}%`;
					video.style.height = `${(rect.h / canvas.height) * 100}%`;
					video.style.transform = `rotate(${rect.rotation}deg) scale(${
						rect.flipX ? -1 : 1
					}, ${rect.flipY ? -1 : 1})`;
					video.style.opacity = String(rect.opacity);
				}
				const localT = tSec - clip.startSec + clip.trimStartSec;
				if (isPlaying) {
					if (Math.abs(video.currentTime - localT) > SYNC_TOLERANCE_SEC) {
						video.currentTime = localT;
					}
					if (video.paused) {
						void video.play().catch(() => undefined);
					}
				} else {
					if (!video.paused) video.pause();
					if (Math.abs(video.currentTime - localT) > 0.02) {
						video.currentTime = localT;
					}
				}
			}
		};

		sync();
		const offUpdate = editor.playback.onUpdate(() => sync());
		const offSeek = editor.playback.onSeek(() => sync());
		const offPlayback = editor.playback.subscribe(() => sync());
		return () => {
			offUpdate();
			offSeek();
			offPlayback();
		};
	}, [editor, clips]);

	if (!clips.length) return null;

	return (
		<>
			{clips.map((clip) => (
				<video
					key={clip.id}
					ref={(node) => {
						if (node) videoRefs.current.set(clip.id, node);
						else videoRefs.current.delete(clip.id);
					}}
					src={clip.url}
					muted
					playsInline
					preload="auto"
					className="pointer-events-none absolute"
					style={{ visibility: "hidden", objectFit: "fill" }}
				/>
			))}
		</>
	);
}
