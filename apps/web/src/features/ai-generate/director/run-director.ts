/**
 * Director orchestrator (U5): assemble -> remove silences -> transcribe -> fuse
 * the audio/source senses -> plan -> OPEN the Review modal. Apply happens on user
 * accept (in the modal), so this resolves once the plan is on screen. Reuses the
 * existing AI-CUT spine; text-only, so it runs on every auth mode.
 *
 * Browser-only (audio decode + fetch) — verified live, not under bun; the pure
 * fusion (`build-signal-table`) and the planner/apply/taste are tested separately.
 */

import {
	assembleBinToTimeline,
	timelineHasContent,
} from "@/features/editing/assemble";
import { runRemoveSilences } from "@/features/editing/remove-silences";
import { ensureTimelineTranscript } from "@/features/transcription/transcript-cache";
import { extractTimelineAudio } from "@/media/mediabunny";
import { decodeAudioToFloat32 } from "@/media/audio";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { buildAiAuthHeaders, useAiSettingsStore } from "@/features/ai-generate/store";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { MoveElementCommand } from "@/commands/timeline/element/move-elements";
import type { PlannedElementMove } from "@/timeline/group-move/types";
import type { EditorCore } from "@/core";
import type { DirectorAssetSummary, DirectorVisionFrame } from "@framecut/hf-bridge";
import { computeEnergyEnvelope, computeSpeechFeatures, ENERGY_WINDOW_SEC } from "./audio-features";
import { buildSignalTable } from "./build-signal-table";
import { toast } from "sonner";
import {
	formatVisionNotice,
	sampleDirectorFrames,
	toVisionFrames,
} from "./director-frames";
import { useDirectorPlanStore } from "./director-plan-store";
import { useDirectorTasteStore } from "./taste";
import { detectDuplicateWordCuts } from "./duplicate-words";
import { detectPhraseRepeatCuts } from "./phrase-repeat";
import { detectDeadAirCuts } from "./dead-air";
import { detectFillerCuts } from "./filler-words";
import { detectPacingCuts } from "./pacing";
import { detectNoiseFragmentCuts } from "./noise-fragment";
import { detectTinyClipCuts } from "./tiny-clip";
import { snapRemovalOps, snapRemovalsToClipEdges } from "./snap-cut";
import { collectVideoClipSpansSec } from "@/features/editing/silence-refine";
import { planChronologicalReorder, type ChronoClip } from "./clip-chronology";
import { buildOpeningDebugReport } from "./director-debug";

declare global {
	interface Window {
		/** Opt-in: when truthy, the Director logs an opening-redundancy debug report (issue A). */
		__directorDebug?: boolean;
	}
}

/** A surviving clip sliver up to this many frames (at the project fps) is a cut
 * remnant worth swallowing — covers the reported 2-frame and 13-frame artifacts. */
const REMNANT_FRAMES_TOLERANCE = 15;

/** A standalone video clip shorter than this (frames at the project fps) is too
 * short to be real footage — a stray fragment proposed for removal in review. */
const MIN_USEFUL_CLIP_FRAMES = 5;

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
		const clips: ChronoClip[] = track.elements
			.filter((element) => element.type === "video")
			.map((element) => ({
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
import { detectSegmentRepeatCuts } from "./segment-repeat";
import { mergeDetectedCuts, type KeeperSpan } from "./cut-utils";
import { groupTranscriptByAsset } from "./source-map";
import { buildTakeClusters } from "./take-clusters";
import { detectRedundancyCuts } from "./redundancy";
import { buildAssetCatalog } from "./asset-catalog";
import { scoreImportance, selectProtectedSpans } from "./importance";

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
	const wordCuts = [
		...detectDuplicateWordCuts({ words: words ?? [] }),
		...detectPhraseRepeatCuts({ words: words ?? [] }),
		...detectDeadAirCuts({ words: words ?? [] }),
		...detectFillerCuts({ words: words ?? [] }),
		...detectPacingCuts({ segments }),
	];
	// Segment-level consecutive-repeat backstop: the ONLY repeat catcher when the
	// model can't emit word timestamps (phrase-repeat then yields nothing). Drop any
	// that overlap a word-level cut so the two layers don't double up in the review.
	const segmentRepeatCuts = detectSegmentRepeatCuts({ segments }).filter(
		(op) =>
			!wordCuts.some((w) => w.startSec < op.endSec && op.startSec < w.endSec),
	);
	const detectedCuts = [...wordCuts, ...segmentRepeatCuts];
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

	// Non-speech noise guard (issue D): a short, loud, WORD-LESS blip between/around
	// the transcript (a bump, breath-pop, room noise) is invisible to every text-
	// driven detector and to the LLM. Scan the gaps over the same energy envelope the
	// features came from and flag the fragments for review.
	const envelope = computeEnergyEnvelope({ samples, sampleRate, windowSec: ENERGY_WINDOW_SEC });
	const noiseCuts = detectNoiseFragmentCuts({ features, envelope, windowSec: ENERGY_WINDOW_SEC });

	// Useless tiny-clip guard (live test): a stray sub-N-frame video clip (no speech,
	// not a removal remnant) survives every other layer, and the reorder can even
	// promote it to the head. Flag any video clip shorter than MIN_USEFUL_CLIP_FRAMES
	// for review. clipSpans + the fps are shared with the cut-remnant snap below.
	const fps = editor.project.getActive().settings.fps;
	const fpsFloat = fps.denominator > 0 ? fps.numerator / fps.denominator : 30;
	const clipSpans = collectVideoClipSpansSec({ tracks, ticksPerSecond: TICKS_PER_SECOND });
	const tinyClipCuts = detectTinyClipCuts({
		clips: clipSpans,
		minDurationSec: MIN_USEFUL_CLIP_FRAMES / fpsFloat,
	});

	// Keep-side signal (Phase B / U1-U4): score each segment's emphasis/anchor
	// importance. It rides the signal table as an advisory "imp" column and yields a
	// CAPPED set of high-value spans (never the whole timeline) that the merge below
	// protects from removal — alongside the take-cluster keepers and the LLM keep ops.
	const importance = scoreImportance({ segments, features });
	const protectedSpans = selectProtectedSpans({ segments, importance });

	// Take-aware redundancy (U4/U6): cluster same-line spans across the assembled
	// clips (and far apart within one), rank the best take, and flag the redundant
	// ones as review ops. Keeper spans are protected in the merge below so a cluster
	// can never lose every take (KTD7). With no clusters (single-take / no repeats)
	// this is a no-op: no grp column, no catalog block — byte-identical request.
	onProgress?.("Comparing takes...");
	const assetTranscripts = groupTranscriptByAsset({
		segments,
		elements: tracks.main.elements,
	});
	const takeClusters = buildTakeClusters({ assetTranscripts, features });
	// Keep-last: each cluster keeps its LATEST take and cuts the earlier near-
	// identical ones within the recency window. `nearTies` is empty (the rare A/B
	// "stitch" choice is the LLM planner's, not this deterministic step).
	const { ops: redundancyOps, nearTies } = detectRedundancyCuts({ clusters: takeClusters });
	const keepers: KeeperSpan[] = takeClusters.map((cluster) => {
		const keeper = cluster.members[cluster.keeperIndex];
		return { startSec: keeper.startSec, endSec: keeper.endSec };
	});
	// Map each clustered segment to a short grp id (C1, C2…) for the signal table, so
	// the planner SEES which rows are alternate takes and skips re-cutting them (U5/KTD3).
	const clusterIds = new Map<number, string>();
	takeClusters.forEach((cluster, ci) => {
		for (const member of cluster.members) {
			clusterIds.set(Math.round(member.startSec * 1000) / 1000, `C${ci + 1}`);
		}
	});
	// Per-clip catalog (U2/U5): the planner reasons over the bin, not a 6-char hash.
	const catalog: DirectorAssetSummary[] = buildAssetCatalog({
		assetTranscripts,
		features,
		assets: editor.media.getAssets().map((a) => ({
			id: a.id,
			name: a.name,
			durationSec: a.duration ?? 0,
		})),
	}).map((entry) => ({
		name: entry.name,
		durationSec: entry.durationSec,
		segmentCount: entry.segmentCount,
		firstLine: entry.firstLine,
		lastLine: entry.lastLine,
	}));
	abort();

	const signalTable = buildSignalTable({
		segments,
		features,
		elements: tracks.main.elements,
		clusterIds,
		importance,
	});
	abort();

	// Vision pass (opt-in): sample one frame per segment so the Director's cuts can
	// SEE the footage. With vision off, `frames` stays empty and the request body
	// is byte-identical to the text-only path (no regression).
	let frames: DirectorVisionFrame[] = [];
	if (useAiSettingsStore.getState().directorVisionEnabled) {
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

	onProgress?.("Directing...");
	const totalSec = (totalDuration as number) / TICKS_PER_SECOND;
	const taste = useDirectorTasteStore.getState().buildDirectorTasteNote();
	const res = await fetch("/api/director/plan", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		signal,
		body: JSON.stringify({
			segments: signalTable,
			totalSec,
			taste: taste || undefined,
			// Catalog only helps with ≥2 clips; omitting it for one clip keeps the
			// single-recording request byte-identical to the pre-asset-context path.
			...(catalog.length >= 2 ? { catalog } : {}),
			...(frames.length > 0 ? { frames } : {}),
		}),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => null);
		throw new Error(err?.error ?? `Director planning failed (${res.status})`);
	}
	const data = await res.json();
	// Tag the LLM ops "vision" when the visual pass actually ran (frames sent AND
	// the backend wasn't degraded to text-only), so the review badge + per-category
	// taste learn vision cuts separately from text-only ones.
	const usedVision = frames.length > 0 && data?.degraded !== true;
	// Cost transparency + the degrade fallback notice (R3/R4).
	const notice = formatVisionNotice({
		frameCount: frames.length,
		degraded: data?.degraded === true,
		inputTokens: data?.usage?.inputTokens,
	});
	if (notice.kind === "warning") {
		toast.warning(notice.message);
	} else if (notice.kind === "info") {
		toast.info(notice.message);
	}
	const rawPlanOps = Array.isArray(data?.plan?.operations)
		? data.plan.operations
		: [];
	const planOps = usedVision
		? rawPlanOps.map((op: Record<string, unknown>) => ({ ...op, category: "vision" }))
		: rawPlanOps;
	// The LLM's keep ops (U4) mark load-bearing spans the imp score may underrate;
	// they protect (never remove), so fold them into the keeper set alongside the
	// take-cluster keepers and the capped high-value spans (U3).
	const llmKeepSpans: KeeperSpan[] = [];
	for (const op of planOps) {
		if (op?.op === "keep") {
			const startSec = Number(op.startSec);
			const endSec = Number(op.endSec);
			if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
				llmKeepSpans.push({ startSec, endSec });
			}
		}
	}
	// Fold the deterministic cuts (word/phrase/dead-air/filler/pacing + the new
	// take/repeat redundancy ops) into the LLM plan, dropping any that overlap a cut
	// it already made AND any that would delete a protected span — take-cluster keeper,
	// capped high-value span, or LLM keep (KTD2/KTD7) — then hand off to the Review modal.
	const mergedOps = mergeDetectedCuts({
		planOps,
		extraOps: [...detectedCuts, ...redundancyOps, ...noiseCuts, ...tinyClipCuts],
		keepers: [...keepers, ...protectedSpans, ...llmKeepSpans],
	}).filter((op) => op.op !== "keep"); // protection is invisible in normal mode (KTD6) — no no-op keep rows
	// Issue E: snap each cut's edges to a nearby low-energy trough so a removal
	// begins and ends in the quiet BETWEEN sounds, not mid-word. Reuses the noise
	// guard's envelope; reorder ops are left untouched.
	const energySnapped = snapRemovalOps({ ops: mergedOps, envelope });
	// Cut-remnant guard (live test): a removal whose boundary lands a few frames shy
	// of a clip edge leaves a tiny sliver of that clip (the 2-frame / 13-frame bits
	// at the start). Snap such a boundary OUT to the clip edge so the cut swallows the
	// remnant. Reuses the clipSpans + fps computed above.
	const operations = snapRemovalsToClipEdges({
		ops: energySnapped,
		clipStartsSec: clipSpans.map((c) => c.startSec),
		clipEndsSec: clipSpans.map((c) => c.endSec),
		toleranceSec: REMNANT_FRAMES_TOLERANCE / fpsFloat,
	});
	// Issue A investigation: opt-in opening-redundancy report (set window.__directorDebug
	// = true in the console before running). Shows the opening transcript, pairwise
	// similarity vs the merge bar, and whether the LLM proposed a cut there — so a
	// paraphrased opening repeat can be tuned against the REAL data, not a guess.
	if (typeof window !== "undefined" && window.__directorDebug) {
		console.log(buildOpeningDebugReport({ segments, planOps, operations }));
	}
	useDirectorPlanStore.getState().openWith({ plan: { operations }, nearTies });
}
