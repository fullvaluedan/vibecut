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
import type { ContextFlag, DirectorAssetSummary, DirectorOp, DirectorVisionFrame } from "@framecut/hf-bridge";
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
import { MIN_SURVIVING_CLIP_FRAMES } from "./content-word";
import { detectVadDeadAirCuts } from "./vad-dead-air";
import { vadService } from "@/services/vad/service";
import { snapRemovalOps } from "./snap-cut";
import { resolveTrimVsCut } from "./resolve-trim-vs-cut";
import { justifyCuts } from "./justify-cuts";
import { collectVideoClipSpansSec } from "@/features/editing/silence-refine";
import { planChronologicalReorder, type ChronoClip } from "./clip-chronology";
import { buildOpeningDebugReport } from "./director-debug";
import { buildRedundancyCatalog } from "./redundancy-catalog";
import { mapContextFlags } from "./context-relevance";
import {
	lexicalBackstopDefaultAccept,
	mapRedundancyGroups,
	shouldRunLexicalRepeatDetectors,
	type RedundancyReviewGroup,
} from "./redundancy-apply";

declare global {
	interface Window {
		/** Opt-in: when truthy, the Director logs an opening-redundancy debug report (issue A). */
		__directorDebug?: boolean;
	}
}

/** A surviving clip sliver up to this many frames (at the project fps) is a cut
 * remnant worth swallowing — covers the reported 2-frame and 13-frame artifacts. */
const REMNANT_FRAMES_TOLERANCE = 15;

/** Silence left behind (frames at the project fps) when tightening a pause that
 * sits next to a repeat/mistake we're cutting anyway (a breath, not a hard splice). */
const PAUSE_FLOOR_FRAMES = 15;

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
import { detectSegmentRepeatCuts } from "./segment-repeat";
import { runSecondPass } from "./second-pass";
import { mergeDetectedCuts, stableCutId, type KeeperSpan } from "./cut-utils";
import {
	computeEmphasisPauseKeepers,
	computeRepeatAdjacentPauseFloors,
} from "./emphasis-pause";
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

	// Transcribe the FULL timeline FIRST so silence removal has word timings for its
	// emphasis-pause protection. On a fresh project with background transcription off
	// nothing is cached yet, so without this the protection was inert and every short
	// mid-sentence pause got cut. The result is fed straight into runRemoveSilences.
	onProgress?.("Transcribing...");
	const preSilence = await ensureTimelineTranscript({
		editor,
		signal,
		wantWords: true,
		onProgress: (p) => onProgress?.(p.detail),
	});
	abort();

	onProgress?.("Removing silences...");
	await runRemoveSilences({ editor, words: preSilence.words });
	abort();

	// Re-transcribe the SHORTENED timeline: the ripple changed the audio hash, so this
	// is a cache miss that re-aligns every downstream coordinate to the new timeline.
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
	// Always-on word-level cleanup (NOT repeat detectors): doubled words, dead air,
	// fillers, pacing — the LLM works at segment level and misses these. The REPEAT
	// detectors (phrase-repeat, segment-repeat) are computed here but only INCLUDED
	// when the dedicated LLM redundancy pass didn't run (R7 fallback, gated below).
	// Doubled words are a stutter/MISTAKE — kept as its own const so it can join the
	// repeat/mistake proximity set that disqualifies an emphasis pause (U2).
	const duplicateWordCuts = detectDuplicateWordCuts({ words: words ?? [] });
	const wordCuts = [
		...duplicateWordCuts,
		...detectDeadAirCuts({ words: words ?? [] }),
		...detectFillerCuts({ words: words ?? [] }),
		...detectPacingCuts({ segments }),
	];
	const phraseRepeatCuts = detectPhraseRepeatCuts({ words: words ?? [] });
	// Segment-level consecutive-repeat backstop (fallback only). Drop any that overlap
	// a word-level / phrase-repeat cut so the layers don't double up in the review.
	const segmentRepeatCuts = detectSegmentRepeatCuts({ segments }).filter(
		(op) =>
			![...wordCuts, ...phraseRepeatCuts].some(
				(w) => w.startSec < op.endSec && op.startSec < w.endSec,
			),
	);
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
	// Compute the RMS energy envelope ONCE and share it: the per-segment features, the
	// non-speech noise guard, and the cut-boundary snap all read the same envelope (so
	// they can never disagree on windowing, and we avoid a redundant O(n) pass).
	const envelope = computeEnergyEnvelope({ samples, sampleRate, windowSec: ENERGY_WINDOW_SEC });
	const features = computeSpeechFeatures({ segments, envelope, windowSec: ENERGY_WINDOW_SEC });

	// Non-speech noise guard (issue D): a short, loud, WORD-LESS blip between/around
	// the transcript (a bump, breath-pop, room noise) is invisible to every text-
	// driven detector and to the LLM. Scan the gaps over the energy envelope and flag
	// the fragments for review.
	const noiseCuts = detectNoiseFragmentCuts({ features, envelope, windowSec: ENERGY_WINDOW_SEC });

	// Micro-clip sweep (2P-U2): a stray sub-floor video clip (no speech, not a removal
	// remnant) survives every other layer, and the reorder can even promote it to the
	// head. Flag any clip shorter than the shared MIN_SURVIVING_CLIP_FRAMES floor; the
	// word-aware split auto-removes content-free shards and leaves content-bearing ones
	// as opt-in rows. clipSpans + the fps are shared with the cut-remnant snap below.
	const fps = editor.project.getActive().settings.fps;
	const fpsFloat =
		fps.denominator > 0 && fps.numerator > 0 ? fps.numerator / fps.denominator : 30;
	const clipSpans = collectVideoClipSpansSec({ tracks, ticksPerSecond: TICKS_PER_SECOND });
	const tinyClipCuts = detectTinyClipCuts({
		clips: clipSpans,
		minDurationSec: MIN_SURVIVING_CLIP_FRAMES / fpsFloat,
		words: words ?? [],
		// Auto-accept needs the shard to overlap SPEECH (F6): a wordless clip outside
		// any segment is what a deliberate visual insert looks like, so it stays opt-in.
		segments,
	});

	// VAD dead-air (Plan A / U5, default ON per U2/KTD3, still a user override): a
	// Silero VAD pass over the decoded audio surfaces long NON-speech gaps as
	// reviewable "dead air" cuts, the silent "just sitting there" a transcript can't
	// see. Runs in its own worker; NON-throwing (a VAD failure must never break the
	// Director) and overlap-filtered against the other detected cuts so it can't
	// double with pacing / dead-air.
	let vadDeadAirCuts: DirectorOp[] = [];
	if (useAiSettingsStore.getState().directorVadDeadAirEnabled) {
		onProgress?.("Scanning for dead air...");
		try {
			const { gaps } = await vadService.detectSpeechGaps({
				samples,
				sampleRate,
				totalSec: (totalDuration as number) / TICKS_PER_SECOND,
			});
			vadDeadAirCuts = detectVadDeadAirCuts({ gaps }).filter(
				(op) =>
					![...wordCuts, ...noiseCuts, ...tinyClipCuts].some(
						(other) => other.startSec < op.endSec && op.startSec < other.endSec,
					),
			);
		} catch {
			// VAD unavailable / failed — skip; the Director runs normally.
		}
		abort();
	}

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
	// Dedicated LLM redundancy pass (R1) — the focused repeat-catcher. On success it is
	// the authority and the lexical repeat detectors stay silent (R7); on a route error
	// it falls through to them. Non-throwing (KTD-5).
	// The numbered-transcript catalog, shared by the redundancy pass and the new
	// out-of-context pass (U3 Part B) so both reason over the same lines.
	const redundancyLines = buildRedundancyCatalog({
		segments,
		features,
		elements: tracks.main.elements,
		clipNameByAssetId: new Map(editor.media.getAssets().map((a) => [a.id, a.name])),
	});
	let redundancyCuts: DirectorOp[] = [];
	let redundancyReviewGroups: RedundancyReviewGroup[] = [];
	let redundancyRan = false;
	// Out-of-context pass (U3 Part B): read the FULL transcript, infer the video's
	// throughline, and flag lines whose dialog does not fit it (tangents, abandoned
	// thoughts, meta-asides, wrong-video content). A flag at/above the shared accept
	// threshold default-accepts so clear mistakes leave the video (2P-U4); the
	// uncertain band stays an opt-in row Dan reviews. Non-throwing: a route error
	// skips Part B entirely. Mapped to ops + overlap-filtered at the merge below.
	let contextFlags: ContextFlag[] = [];
	// The two LLM passes read the SAME catalog and neither consumes the other's
	// output, so they run CONCURRENTLY: awaiting them back-to-back added a full LLM
	// round-trip of pure wait to every Director run (review F9). Each stays
	// individually non-throwing, so Promise.all never rejects.
	const redundancyPass = async () => {
		try {
			const rRes = await fetch("/api/director/redundancy", {
				method: "POST",
				headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
				signal,
				body: JSON.stringify({ lines: redundancyLines, taste: taste || undefined }),
			});
			if (rRes.ok) {
				const rData = await rRes.json();
				const groups = Array.isArray(rData?.plan?.groups) ? rData.plan.groups : [];
				const mapped = mapRedundancyGroups({ groups });
				redundancyCuts = mapped.cuts;
				redundancyReviewGroups = mapped.groups;
				redundancyRan = true;
			}
		} catch {
			// route error → fall through to the lexical repeat detectors (KTD-5)
		}
	};
	const contextPass = async () => {
		if (segments.length === 0) return;
		try {
			const cRes = await fetch("/api/director/context", {
				method: "POST",
				headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
				signal,
				body: JSON.stringify({ lines: redundancyLines, taste: taste || undefined }),
			});
			if (cRes.ok) {
				const cData = await cRes.json();
				contextFlags = Array.isArray(cData?.plan?.flags) ? cData.plan.flags : [];
			}
		} catch {
			// route error → skip the out-of-context pass (it is an enhancement)
		}
	};
	onProgress?.("Checking repeats and the throughline...");
	await Promise.all([redundancyPass(), contextPass()]);
	shouldRunLexicalRepeatDetectors(); // always run now (U5/R5) — kept for intent
	abort();

	// Fold the always-on cleanup + the lexical repeat detectors into the LLM plan,
	// protecting take-cluster keepers + the importance floor + LLM keeps. The repeat
	// detectors run ADDITIVELY alongside the LLM pass (U5/R5): when the LLM pass ran
	// they are a backstop for repeats it missed. Phrase-repeat cuts are VERBATIM n-gram
	// matches (>=4 consecutive identical tokens, i.e. clearly-duplicate content), so they
	// auto-accept by default even when additive, letting obvious repeats leave the
	// timeline without row-toggling (U1/KTD2, high-confidence-only). The softer near-
	// identical backstops (segment-repeat + the take-cluster redundancyOps) stay accept-
	// OFF review rows (opt-in, never auto-cut newly-surfaced content, per OQ3/R7) when
	// additive, and only on route-error fallback are they the sole authority and keep
	// the accepted default.
	const withBackstopAccept = (op: DirectorOp, verbatim: boolean): DirectorOp =>
		lexicalBackstopDefaultAccept({ verbatim, redundancyRan })
			? op
			: { ...op, defaultAccept: false };
	const lexicalRepeatCuts = [
		...phraseRepeatCuts.map((op) => withBackstopAccept(op, true)),
		...segmentRepeatCuts.map((op) => withBackstopAccept(op, false)),
		...redundancyOps.map((op) => withBackstopAccept(op, false)),
	];
	// Emphasis-pause protection (#4/U2): keep a short, speech-bounded in-dialog pause
	// as a deliberate beat unless a repeat/mistake sits next to it. The repeat/mistake
	// spans must be known FIRST (they disqualify a pause), so collect every repeat- and
	// mistake-sourced cut in scope, then protect the qualifying inter-segment gaps via
	// keepers — mergeDetectedCuts drops the pacing / vad-dead-air removals over them,
	// suppressing ALL pause-removing sources at once (R2/KTD2). No words -> no keepers.
	const repeatMistakeSpans = [
		...duplicateWordCuts,
		...phraseRepeatCuts,
		...segmentRepeatCuts,
		...redundancyOps,
		...redundancyCuts,
	].map((op) => ({ startSec: op.startSec, endSec: op.endSec }));
	const pauseGaps: { start: number; end: number }[] = [];
	for (let i = 1; i < segments.length; i++) {
		const start = segments[i - 1].end;
		const end = segments[i].start;
		if (end > start) pauseGaps.push({ start, end });
	}
	const emphasisPauseKeepers = computeEmphasisPauseKeepers({
		gaps: pauseGaps,
		words: words ?? [],
		repeatSpans: repeatMistakeSpans,
	});
	// 15-frame floor (#3): a pause that WOULD be a beat but sits next to a repeat/
	// mistake is disqualified above (no keeper), so it would otherwise stay whole. It's
	// part of the mess we're cutting there anyway, so tighten it to a PAUSE_FLOOR_FRAMES
	// breath instead of leaving the full pause. Added as removals below; they can't be
	// protected away because these gaps have no keeper (the near-repeat test excluded them).
	const pauseFloorCuts: DirectorOp[] = computeRepeatAdjacentPauseFloors({
		gaps: pauseGaps,
		words: words ?? [],
		repeatSpans: repeatMistakeSpans,
		floorSec: PAUSE_FLOOR_FRAMES / fpsFloat,
	}).map((cut) => ({
		id: `pausefloor-${stableCutId(`${cut.startSec.toFixed(3)}:${cut.endSec.toFixed(3)}`)}`,
		op: "cut",
		startSec: cut.startSec,
		endSec: cut.endSec,
		reason: "Tightened pause next to a repeat/mistake (left a short breath)",
		confidence: 0.6,
		category: "pacing",
	}));
	// Out-of-context flags → opt-in cut ops (U3 Part B), dropped where they overlap a
	// removal another detector already made, so a context row never doubles a repeat /
	// dead-air / redundancy cut. They fold into the merge as accept-OFF extraOps,
	// protected by the same keepers + emphasis-pause keepers as the other backstops.
	const contextCuts = mapContextFlags({
		flags: contextFlags,
		existingCuts: [
			...wordCuts,
			...noiseCuts,
			...tinyClipCuts,
			...vadDeadAirCuts,
			...lexicalRepeatCuts,
			...pauseFloorCuts,
			...redundancyCuts,
		],
	});
	const baseMerged = mergeDetectedCuts({
		planOps,
		extraOps: [
			...wordCuts,
			...noiseCuts,
			...tinyClipCuts,
			...vadDeadAirCuts,
			...lexicalRepeatCuts,
			...pauseFloorCuts,
			...contextCuts,
		],
		keepers: [...keepers, ...protectedSpans, ...llmKeepSpans, ...emphasisPauseKeepers],
	}).filter((op) => op.op !== "keep"); // protection is invisible in normal mode (KTD6)
	// Redundancy cuts are the redundancy AUTHORITY (KTD-7): folded in protected ONLY by
	// explicit LLM keep ops — the capped importance floor must not veto them.
	const mergedOps =
		redundancyRan && redundancyCuts.length > 0
			? mergeDetectedCuts({
					// A redundancy take is removed WHOLE. Drop any cleaning removal
					// (filler/pause/dead-air) fully INSIDE a redundancy span first —
					// otherwise that small contained cut would dedup the bigger redundancy
					// cut away (mergeDetectedCuts drops an extraOp overlapping a surviving
					// removal), leaving most of the take in AND killing its review row. The
					// redundancy cut subsumes the contained one, so nothing is lost. Reorders
					// are never removals — always keep them.
					planOps: baseMerged.filter(
						(op) =>
							op.op === "reorder" ||
							!redundancyCuts.some(
								(rc) => rc.startSec <= op.startSec && op.endSec <= rc.endSec,
							),
					),
					extraOps: redundancyCuts,
					// Carry the emphasis-pause keepers through the SECOND pass too, so a
					// protected pause survives both merges. Today no redundancy cut lands on a
					// protected gap (the proximity check disqualifies any gap near one upstream),
					// but re-passing the keepers hardens that invariant instead of relying on it.
					keepers: [...llmKeepSpans, ...emphasisPauseKeepers],
				}).filter((op) => op.op !== "keep")
			: baseMerged;
	// Issue E: snap each cut's edges to a nearby low-energy trough so a removal
	// begins and ends in the quiet BETWEEN sounds, not mid-word. Reuses the noise
	// guard's envelope; reorder ops are left untouched.
	// Virtual second pass (2P-U3): re-analyze the Director's OWN compressed output.
	// Compression reveals adjacency: two verbatim takes >60s apart only become close
	// enough to match once the material between them is cut, so apply the default-
	// accepted cuts to the transcript virtually and re-run the deterministic detectors
	// on the shortened result, mapping any new findings back to original coordinates.
	// Deterministic + transcript-only (no re-transcription, no LLM re-runs), capped at
	// 3 passes, folded into the SAME review and undo. Pure: it computes ops only, the
	// same keepers protect each pass, and the extra ops flow through the SAME snap/
	// coalesce chain below as the pass-1 cuts.
	const secondPass = runSecondPass({
		ops: mergedOps,
		words: words ?? [],
		segments,
		keepers: [...keepers, ...protectedSpans, ...llmKeepSpans, ...emphasisPauseKeepers],
		redundancyRan,
	});
	if (secondPass.extraOps.length > 0) {
		const extraPasses = secondPass.passesRun - 1;
		toast.info(
			`Director second pass: found ${secondPass.extraOps.length} more cut${secondPass.extraOps.length === 1 ? "" : "s"} the compression revealed (${extraPasses} extra pass${extraPasses === 1 ? "" : "es"}).`,
		);
	}
	const withSecondPass = [...mergedOps, ...secondPass.extraOps].sort(
		(a, b) => a.startSec - b.startSec,
	);
	// Issue E: snap each cut's edges to a nearby low-energy trough so a removal
	// begins and ends in the quiet BETWEEN sounds, not mid-word. Reuses the noise
	// guard's envelope; reorder ops are left untouched.
	const energySnapped = snapRemovalOps({ ops: withSecondPass, envelope });
	// Trim-vs-cut (U4/KTD4): a removal whose edge lands within a few frames of a clip
	// boundary is aligned to it so the removal TRIMS that clip edge (swallowing the
	// 2-frame / 13-frame slivers a cut left) instead of fragmenting the clip; a removal
	// with both edges mid-clip stays a ripple-cut. Reuses the clipSpans + fps above.
	// (Adjacent same-source slices are then merged post-apply by the consolidation pass.)
	const trimmed = resolveTrimVsCut({
		ops: energySnapped,
		clipStartsSec: clipSpans.map((c) => c.startSec),
		clipEndsSec: clipSpans.map((c) => c.endSec),
		toleranceSec: REMNANT_FRAMES_TOLERANCE / fpsFloat,
	});
	// No unnecessary cuts (2P-U5/R9): revert any sub-floor removal that splices two
	// content words in continuous speech and carries no concrete reason, so a boundary
	// is never created mid-sentence for nothing. Real pauses (silence removals) keep
	// their flanking words a floor apart and are untouched. Fail-open with no words.
	const operations = justifyCuts({
		ops: trimmed,
		words: words ?? [],
		floorSec: MIN_SURVIVING_CLIP_FRAMES / fpsFloat,
	});
	// Spans the APPLY-time coalescer must never swallow (review F5): every plan-time
	// keeper (a word-free protected pause has no word-guard protection at apply) plus
	// each cut justify reverted just above (re-swallowing it would re-create the exact
	// unjustified boundary 2P-U5 removed). The review surfaces add the user-rejected
	// rows at apply time.
	const justifyKept = new Set(operations);
	const applyProtectedSpans = [
		...[...keepers, ...protectedSpans, ...llmKeepSpans, ...emphasisPauseKeepers].map(
			(k) => ({ startSec: k.startSec, endSec: k.endSec }),
		),
		...trimmed
			.filter((op) => !justifyKept.has(op))
			.map((op) => ({ startSec: op.startSec, endSec: op.endSec })),
	];
	// Issue A investigation: opt-in opening-redundancy report (set window.__directorDebug
	// = true in the console before running). Shows the opening transcript, pairwise
	// similarity vs the merge bar, and whether the LLM proposed a cut there — so a
	// paraphrased opening repeat can be tuned against the REAL data, not a guess.
	if (typeof window !== "undefined" && window.__directorDebug) {
		console.log(buildOpeningDebugReport({ segments, planOps, operations }));
	}
	useDirectorPlanStore.getState().openCutPanel({
		plan: { operations },
		nearTies,
		// Carry the groups so the review can offer swap-to-alternate; a group whose
		// cuts were all deduped/snapped away simply has no row to attach a dropdown to.
		redundancyGroups: redundancyReviewGroups,
		// Carry the transcript words so the apply-time sliver coalescing (2P-U1) can
		// word-guard which sub-floor gaps it swallows.
		words: words ?? [],
		protectedSpans: applyProtectedSpans,
	});
}
