/**
 * Client orchestration for the graphics-generate buttons. Mirrors run-hyperframes but
 * the heavy work runs server-side in a detached worker (a ~2hr render must not be tied
 * to this tab); here we just stage inputs, kick the job, and poll its status. Timeline
 * placement of the finished render is done by the caller once `fullPath` appears.
 */
import type { EditorCore } from "@/core";
import { ensureTimelineTranscript } from "@/features/transcription/transcript-cache";
import { placeHyperframesRender } from "@/features/ai-generate/place-hyperframes-render";
import type { GraphicsEngine, GraphicsJob } from "./job-types";

/** Find the source talking-head video File to hand the graphics generator: the first
 * video element on the main track, resolved to its imported media File. */
function findSourceVideoFile(editor: EditorCore): File | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	const assets = editor.media.getAssets();
	const byId = new Map(assets.map((a) => [a.id, a] as const));
	for (const track of [tracks.main, ...tracks.overlay]) {
		if (track.type !== "video") continue;
		for (const el of track.elements) {
			if (el.type !== "video") continue;
			const mediaId = (el as unknown as { mediaId?: string }).mediaId;
			const asset = mediaId ? byId.get(mediaId) : undefined;
			if (asset?.file) return asset.file;
		}
	}
	// Fallback: any video asset in the bin.
	return assets.find((a) => a.type === "video" && a.file)?.file ?? null;
}

/**
 * Stage the current video + transcript and start a graphics job. Returns the job id.
 * Throws with a user-facing message when there is no source video or the request fails.
 */
export async function startGraphicsJob({
	editor,
	engine,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	engine: GraphicsEngine;
	onProgress?: (detail: string) => void;
	signal?: AbortSignal;
}): Promise<string> {
	const file = findSourceVideoFile(editor);
	if (!file) throw new Error("No source video on the timeline to generate graphics for.");

	onProgress?.("Transcribing...");
	const { segments, words } = await ensureTimelineTranscript({
		editor,
		signal,
		wantWords: true,
		onProgress: (p) => onProgress?.(p.detail),
	});
	const text = segments.map((s) => s.text).join(" ").trim();
	const transcript = JSON.stringify({ text, segments, words });

	onProgress?.("Uploading source video...");
	const form = new FormData();
	form.append("video", file, "source.mp4");
	form.append("transcript", transcript);
	form.append("engine", engine);

	const res = await fetch("/api/graphics/start", { method: "POST", body: form, signal });
	if (!res.ok) {
		const msg = await res.json().catch(() => ({}));
		throw new Error(msg?.error || `Failed to start (${res.status})`);
	}
	const { id } = (await res.json()) as { id: string };
	return id;
}

/** One poll of a job's status. Returns null when the job is not found (yet). */
export async function fetchGraphicsStatus(id: string): Promise<GraphicsJob | null> {
	const res = await fetch(`/api/graphics/status?id=${encodeURIComponent(id)}`);
	if (!res.ok) return null;
	const { job } = (await res.json()) as { job: GraphicsJob };
	return job;
}

/**
 * Pull a finished render back from the worker and drop it on the timeline. Reuses the
 * blessed HyperFrames placement: a BRAND-NEW video track at t=0 (never overwrites Dan's
 * footage) with its audio split onto its own fresh audio track. Returns where it landed.
 */
export async function importGraphicsRender({
	editor,
	id,
	engine,
	kind = "full",
}: {
	editor: EditorCore;
	id: string;
	engine: GraphicsEngine;
	kind?: "full" | "proof";
}) {
	const res = await fetch(`/api/graphics/file?id=${encodeURIComponent(id)}&kind=${kind}`);
	if (!res.ok) {
		const msg = await res.json().catch(() => ({}));
		throw new Error(msg?.error || `Could not fetch the render (${res.status})`);
	}
	const blob = await res.blob();
	const label = engine === "remotion" ? "Remotion" : "HyperFrames";
	const file = new File([blob], `${id}-${kind}.mp4`, { type: "video/mp4" });
	return placeHyperframesRender({
		editor,
		file,
		scope: { kind: "timeline", label: `${label} graphics`, startSec: 0 },
		name: `${label} graphics${kind === "proof" ? " (proof)" : ""}`,
		templateId: `graphics:${engine}`,
	});
}

export async function approveFullRender(id: string): Promise<void> {
	await fetch("/api/graphics/render-full", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	});
}

export async function cancelGraphicsJob(id: string): Promise<void> {
	await fetch("/api/graphics/cancel", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	});
}
