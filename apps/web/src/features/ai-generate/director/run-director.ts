/**
 * Director orchestrator (U5): assemble -> remove silences -> transcribe -> fuse
 * the audio/source senses -> plan -> OPEN the Review modal. Apply happens on user
 * accept (in the modal), so this resolves once the plan is on screen. Reuses the
 * existing AI-CUT spine; text-only, so it runs on every auth mode.
 *
 * Browser-only (audio decode + fetch) — verified live, not under bun; the pure
 * fusion (`build-signal-table`) and the planner/apply/taste are tested separately.
 */

import { assembleBinToTimeline } from "@/features/editing/assemble";
import { runRemoveSilences } from "@/features/editing/remove-silences";
import { ensureTimelineTranscript } from "@/features/transcription/transcript-cache";
import { extractTimelineAudio } from "@/media/mediabunny";
import { decodeAudioToFloat32 } from "@/media/audio";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { buildAiAuthHeaders } from "@/features/ai-generate/store";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditorCore } from "@/core";
import { computeSpeechFeatures } from "./audio-features";
import { buildSignalTable } from "./build-signal-table";
import { useDirectorPlanStore } from "./director-plan-store";
import { useDirectorTasteStore } from "./taste";
import { detectDuplicateWordCuts } from "./duplicate-words";
import { detectFillerCuts } from "./filler-words";
import { detectPacingCuts } from "./pacing";
import { mergeDetectedCuts } from "./cut-utils";

/**
 * Plan a Director's cut and open the Review modal. Resolves once the plan is on
 * screen (apply is the modal's job). Throws "Cancelled" if aborted; throws a typed
 * message on no-speech / planning failure (the caller surfaces it).
 */
export async function runDirector({
	editor,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	onProgress?: (detail: string) => void;
	signal?: AbortSignal;
}): Promise<void> {
	const abort = () => {
		if (signal?.aborted) throw new Error("Cancelled");
	};

	onProgress?.("Assembling your footage...");
	assembleBinToTimeline({ editor, assets: editor.media.getAssets() });
	abort();

	onProgress?.("Removing silences...");
	await runRemoveSilences({ editor });
	abort();

	onProgress?.("Transcribing...");
	const { segments, words } = await ensureTimelineTranscript({
		editor,
		signal,
		wantWords: true,
		onProgress: (p) => onProgress?.(p.detail),
	});
	if (!segments.length) {
		throw new Error("No speech found — the Director plans from the transcript.");
	}
	// Deterministic word-level cuts (the LLM works at segment level and misses
	// doubled words + standalone fillers inside a segment) — merged into the plan
	// below, deduped against the LLM's removals.
	const detectedCuts = [
		...detectDuplicateWordCuts({ words: words ?? [] }),
		...detectFillerCuts({ words: words ?? [] }),
		...detectPacingCuts({ segments }),
	];
	abort();

	onProgress?.("Listening to the takes...");
	const tracks = editor.scenes.getActiveScene().tracks;
	const totalDuration = editor.timeline.getTotalDuration();
	const audioBlob = await extractTimelineAudio({
		tracks,
		mediaAssets: editor.media.getAssets(),
		totalDuration,
	});
	const { samples, sampleRate } = await decodeAudioToFloat32({
		audioBlob,
		sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	});
	const features = computeSpeechFeatures({ segments, samples, sampleRate });
	const signalTable = buildSignalTable({
		segments,
		features,
		elements: tracks.main.elements,
	});
	abort();

	onProgress?.("Directing...");
	const totalSec = (totalDuration as number) / TICKS_PER_SECOND;
	const taste = useDirectorTasteStore.getState().buildDirectorTasteNote();
	const res = await fetch("/api/director/plan", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		signal,
		body: JSON.stringify({ segments: signalTable, totalSec, taste: taste || undefined }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => null);
		throw new Error(err?.error ?? `Director planning failed (${res.status})`);
	}
	const data = await res.json();
	// Fold the deterministic duplicate-word cuts into the LLM plan (dropping any
	// that overlap a cut it already made), then hand off to the Review modal —
	// apply (and the taste capture) happen on accept.
	const planOps = Array.isArray(data?.plan?.operations)
		? data.plan.operations
		: [];
	const operations = mergeDetectedCuts({ planOps, extraOps: detectedCuts });
	useDirectorPlanStore.getState().openWith({ operations });
}
