/**
 * Director orchestrator (U5): assemble -> transcribe ONCE -> fuse the audio/source
 * senses -> plan -> OPEN the Review modal. Apply happens on user accept (in the
 * modal), so this resolves once the plan is on screen. Reuses the existing AI-CUT
 * spine; text-only, so it runs on every auth mode.
 *
 * This file is the SENSE-GATHERING shell: it decodes audio, runs VAD, samples
 * vision frames, reads the stores, and wraps the three planning routes in an
 * `llm` adapter — then hands everything to the pure `buildDirectorProposals`
 * module, which owns the detector/merge/second-pass/justify pipeline. The eval
 * imports that SAME module with fixture-supplied senses, so it measures the real
 * pipeline, not a lookalike (KTD1/KTD2). Only the decode + fetch are browser-
 * coupled and verified live; the pure pipeline is tested separately.
 *
 * Silence is REVIEW-ONLY here (Dan's cut-storm report 2026-07-04): the old
 * unreviewed remove-silences pre-pass hard-spliced every 0.6s+ pause BEFORE any
 * guard existed, shattering the timeline and forcing a second transcription. Now
 * VAD dead-air (long gaps) + pacing (tighten, keep a beat) surface every pause as
 * review ops that flow through the full guard chain (keepers, justify, coalesce,
 * consolidation, the user's checkboxes). The standalone Remove Silences menu
 * action is unchanged.
 */

import {
	assembleBinToTimeline,
	timelineHasContent,
} from "@/features/editing/assemble";
import { ensureTimelineTranscript } from "@/features/transcription/transcript-cache";
import { extractTimelineAudio } from "@/media/mediabunny";
import { decodeAudioToFloat32 } from "@/media/audio";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { buildAiAuthHeaders, useAiSettingsStore } from "@/features/ai-generate/store";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { MoveElementCommand } from "@/commands/timeline/element/move-elements";
import type { PlannedElementMove } from "@/timeline/group-move/types";
import type { EditorCore } from "@/core";
import type { DirectorVisionFrame } from "@framecut/hf-bridge";
import {
	computeEnergyEnvelope,
	computeSpeechFeatures,
	ENERGY_WINDOW_SEC,
} from "./audio-features";
import { toast } from "sonner";
import {
	formatVisionNotice,
	sampleDirectorFrames,
	toVisionFrames,
} from "./director-frames";
import { useDirectorPlanStore } from "./director-plan-store";
import { useDirectorTasteStore } from "./taste";
import { vadService } from "@/services/vad/service";
import { collectVideoClipSpansSec } from "@/features/editing/silence-refine";
import { planChronologicalReorder, type ChronoClip } from "./clip-chronology";
import type { SpeechGap } from "./vad-dead-air";
import {
	buildDirectorProposals,
	type DirectorLlmAdapter,
	type DirectorPlanResponse,
	type DirectorRedundancyResponse,
	type DirectorContextResponse,
	type DirectorRetakeRequest,
	type DirectorRetakeResponse,
} from "./build-director-proposals";

declare global {
	interface Window {
		/** Opt-in: when truthy, the Director logs an opening-redundancy debug report (issue A). */
		__directorDebug?: boolean;
	}
}

/**
 * Pre-pass (live test): if a video track's clips are timestamped recordings placed
 * out of chronological order, re-sequence them back-to-back in timestamp order
 * BEFORE the Director transcribes + cuts, so the cut runs on the right order. Each
 * video track is reordered within itself (handles clips on V1 OR an overlay lane).
 * One MoveElementCommand (one undo) covering all tracks; a no-op when clips are
 * already ordered or aren't all timestamped. Returns the number of clips moved.
 */
function reorderClipsByTimestamp({ editor }: { editor: EditorCore }): number {
	const tracks = editor.scenes.getActiveScene().tracks;
	const videoTracks = [tracks.main, ...tracks.overlay].filter(
		(track) => track.type === "video",
	);
	const plannedMoves: PlannedElementMove[] = [];
	for (const track of videoTracks) {
		const videoElements = track.elements.filter((element) => element.type === "video");
		// Don't reorder a track whose clips have SEPARATED linked audio — MoveElementCommand
		// moves only the video, leaving its linked audio partner behind (A/V desync baked in
		// before the cut). Conservative: skip rather than risk the desync.
		if (videoElements.some((element) => element.linkId)) continue;
		const clips: ChronoClip[] = videoElements.map((element) => ({
			elementId: element.id,
			name: element.name,
			startTimeTicks: element.startTime,
			durationTicks: element.duration,
		}));
		const moves = planChronologicalReorder({ clips });
		if (!moves) continue;
		for (const move of moves) {
			plannedMoves.push({
				sourceTrackId: track.id,
				targetTrackId: track.id,
				elementId: move.elementId,
				newStartTime: mediaTime({ ticks: move.newStartTimeTicks }),
			});
		}
	}
	if (plannedMoves.length === 0) return 0;
	editor.command.execute({ command: new MoveElementCommand({ moves: plannedMoves }) });
	return plannedMoves.length;
}

/**
 * Plan a Director's cut and open the Review modal. Resolves once the plan is on
 * screen (apply is the modal's job). Throws "Cancelled" if aborted; throws a typed
 * message on no-speech / planning failure (the caller surfaces it).
 */
export async function runDirector({
	editor,
	onProgress,
	signal,
	compressionTarget,
}: {
	editor: EditorCore;
	onProgress?: (detail: string) => void;
	signal?: AbortSignal;
	/** Compression contract (U3/KTD4): fraction of words to REMOVE (0..0.8). Threaded
	 * to the plan pass; sourced from the UI later — undefined = today's behavior. */
	compressionTarget?: number;
}): Promise<void> {
	const abort = () => {
		if (signal?.aborted) throw new Error("Cancelled");
	};

	// Only pull the whole bin onto the timeline when it's EMPTY. If the user
	// already placed clips, the Director edits exactly those — it must not drag
	// the rest of the bin in (the bug where AI CUT added every asset).
	if (!timelineHasContent({ editor })) {
		onProgress?.("Assembling your footage...");
		assembleBinToTimeline({ editor, assets: editor.media.getAssets() });
	}
	abort();

	// Put timestamped clips in chronological order before cutting (live test: clips
	// placed in reverse weren't re-sequenced). No-op unless every clip on a track is
	// timestamped and out of order; one undo with the rest of the flow.
	const reordered = reorderClipsByTimestamp({ editor });
	if (reordered > 0) {
		toast.info(`Director: put ${reordered} clips in chronological order (by filename time).`);
	}
	abort();

	// ONE transcription of the full timeline. Silence is no longer pre-cut by an
	// unreviewed command, so this transcript stays aligned to the timeline the user
	// actually sees, no re-transcription needed, and every pause reaches the review
	// as a VAD dead-air / pacing op with the full guard chain applied.
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
	abort();

	// Decode the timeline audio ONCE and share the RMS energy envelope: the
	// per-segment features, the non-speech noise guard, and the cut-boundary snap
	// all read the same envelope (so they can never disagree on windowing), and we
	// avoid a redundant O(n) pass.
	onProgress?.("Listening to the takes...");
	const tracks = editor.scenes.getActiveScene().tracks;
	const totalDuration = editor.timeline.getTotalDuration();
	const totalSec = (totalDuration as number) / TICKS_PER_SECOND;
	const audioBlob = await extractTimelineAudio({
		tracks,
		mediaAssets: editor.media.getAssets(),
		totalDuration,
	});
	const { samples, sampleRate } = await decodeAudioToFloat32({
		audioBlob,
		sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	});
	const envelope = computeEnergyEnvelope({ samples, sampleRate, windowSec: ENERGY_WINDOW_SEC });
	const features = computeSpeechFeatures({ segments, envelope, windowSec: ENERGY_WINDOW_SEC });
	abort();

	// VAD dead-air (Plan A / U5, default ON per U2/KTD3, still a user override): a
	// Silero VAD pass over the decoded audio surfaces long NON-speech gaps the
	// transcript can't see. Runs in its own worker; NON-throwing (a VAD failure must
	// never break the Director). The pure pipeline filters/energy-tests the gaps.
	const vadEnabled = useAiSettingsStore.getState().directorVadDeadAirEnabled;
	let gaps: SpeechGap[] = [];
	if (vadEnabled) {
		onProgress?.("Scanning for dead air...");
		try {
			const detected = await vadService.detectSpeechGaps({
				samples,
				sampleRate,
				totalSec,
			});
			gaps = detected.gaps;
		} catch {
			// VAD unavailable / failed — skip; the Director runs normally.
		}
		abort();
	}

	// Shared clip geometry: the video clip spans (seconds) feed the tiny-clip sweep,
	// the cut-remnant snap, and trim-vs-cut. The fps float drives the frame floors.
	const fps = editor.project.getActive().settings.fps;
	const fpsFloat =
		fps.denominator > 0 && fps.numerator > 0 ? fps.numerator / fps.denominator : 30;
	const clipSpans = collectVideoClipSpansSec({ tracks, ticksPerSecond: TICKS_PER_SECOND });

	// Vision pass (opt-in): sample one frame per segment so the Director's cuts can
	// SEE the footage. With vision off, `frames` stays empty and the request body
	// is byte-identical to the text-only path (no regression).
	const visionEnabled = useAiSettingsStore.getState().directorVisionEnabled;
	let frames: DirectorVisionFrame[] = [];
	if (visionEnabled) {
		onProgress?.("Looking at the footage...");
		const sampled = await sampleDirectorFrames({
			segments,
			elements: tracks.main.elements,
			assets: editor.media.getAssets(),
			signal,
		});
		frames = toVisionFrames(sampled);
		abort();
	}

	const taste = useDirectorTasteStore.getState().buildDirectorTasteNote();
	const assets = editor.media.getAssets().map((a) => ({
		id: a.id,
		name: a.name,
		durationSec: a.duration ?? 0,
	}));

	// LLM adapter seam (KTD2): wraps the route fetches, unchanged — same auth
	// headers, same abort signal. `plan` throws on failure (the Director aborts, as
	// it always has); `redundancy`/`context` throw on a route error and the pure
	// pipeline falls back. The vision degrade/cost toast lives here because it
	// depends on `formatVisionNotice` + `toast` (browser-only), keeping the pure
	// pipeline free of the media/UI layer. `retake` (U4) is a fourth, OPTIONAL fetch,
	// present only when the user has opted in — see the method below.
	const llm: DirectorLlmAdapter = {
		async plan(planInput) {
			const res = await fetch("/api/director/plan", {
				method: "POST",
				headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
				signal,
				body: JSON.stringify(planInput),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => null);
				throw new Error(err?.error ?? `Director planning failed (${res.status})`);
			}
			const data = (await res.json()) as DirectorPlanResponse;
			// Cost transparency + the degrade fallback notice (R3/R4).
			const notice = formatVisionNotice({
				frameCount: planInput.frames?.length ?? 0,
				degraded: data?.degraded === true,
				inputTokens: data?.usage?.inputTokens,
			});
			if (notice.kind === "warning") {
				toast.warning(notice.message);
			} else if (notice.kind === "info") {
				toast.info(notice.message);
			}
			return data;
		},
		async redundancy(input) {
			const res = await fetch("/api/director/redundancy", {
				method: "POST",
				headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
				signal,
				body: JSON.stringify(input),
			});
			if (!res.ok) throw new Error(`Director redundancy failed (${res.status})`);
			return (await res.json()) as DirectorRedundancyResponse;
		},
		async context(input) {
			const res = await fetch("/api/director/context", {
				method: "POST",
				headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
				signal,
				body: JSON.stringify(input),
			});
			if (!res.ok) throw new Error(`Director context failed (${res.status})`);
			return (await res.json()) as DirectorContextResponse;
		},
		// Retake-hunt pass (U4): OMITTED unless the user has opted in (`directorRetake`,
		// default OFF per the U5 verdict — match-neutral-at-best, so it ships available
		// but not on by default, R10). Omitting the method entirely (rather than gating
		// inside it) makes `buildDirectorProposals`'s `if (llm.retake)` guard skip the
		// pass for zero cost, matching the eval adapter's `enableRetake` convention.
		...(useAiSettingsStore.getState().directorRetake
			? {
					async retake(input: DirectorRetakeRequest): Promise<DirectorRetakeResponse> {
						const res = await fetch("/api/director/retake", {
							method: "POST",
							headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
							signal,
							body: JSON.stringify(input),
						});
						if (!res.ok) throw new Error(`Director retake failed (${res.status})`);
						return (await res.json()) as DirectorRetakeResponse;
					},
				}
			: {}),
	};

	const { operations, nearTies, redundancyGroups, applyProtectedSpans } =
		await buildDirectorProposals({
			words: words ?? [],
			segments,
			features,
			envelope,
			gaps,
			clipSpans,
			fps: fpsFloat,
			elements: tracks.main.elements,
			assets,
			frames,
			taste: taste || undefined,
			totalSec,
			config: { vadEnabled, visionEnabled },
			compressionTarget,
			llm,
			onProgress,
			// The pipeline's own review-time notices (the second-pass toast); the
			// vision notice is emitted inside the plan adapter above.
			onNotice: (notice) => {
				if (notice.kind === "warning") toast.warning(notice.message);
				else toast.info(notice.message);
			},
			signal,
		});

	useDirectorPlanStore.getState().openCutPanel({
		plan: { operations },
		nearTies,
		// Carry the groups so the review can offer swap-to-alternate; a group whose
		// cuts were all deduped/snapped away simply has no row to attach a dropdown to.
		redundancyGroups,
		// Carry the transcript words so the apply-time sliver coalescing (2P-U1) can
		// word-guard which sub-floor gaps it swallows.
		words: words ?? [],
		protectedSpans: applyProtectedSpans,
	});
}
