"use client";

/**
 * Renders FrameCut AI overlay clips (alpha WebMs) over the preview canvas
 * using <video> elements. The browser's media stack decodes VP9 alpha
 * correctly, unlike the WebCodecs path the canvas compositor uses — those
 * clips are excluded from the render tree (see scene-builder.ts) and shown
 * here instead. Exports composite them server-side with ffmpeg.
 */

import { useEffect, useMemo, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { TICKS_PER_SECOND } from "@/wasm";
import type { VideoElement } from "@/timeline";

interface AiOverlayClip {
	id: string;
	url: string;
	startSec: number;
	endSec: number;
	trimStartSec: number;
	hidden: boolean;
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
					trimStartSec: video.trimStart / TICKS_PER_SECOND,
					hidden: !!video.hidden || !!track.hidden,
				});
			}
		}
		return out;
	}, [tracks, mediaAssets]);

	useEffect(() => {
		const sync = () => {
			const tSec = editor.playback.getCurrentTime() / TICKS_PER_SECOND;
			const isPlaying = editor.playback.getIsPlaying();
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
					className="pointer-events-none absolute inset-0 size-full"
					style={{ visibility: "hidden", objectFit: "fill" }}
				/>
			))}
		</>
	);
}
