/**
 * Highlight orchestrator (U7): the keep-side inverse of `runDirector`. Reuses the
 * same spine — assemble → remove silences → transcribe → audio features — then
 * scores emphasis/anchor importance, selects the keep spans, and opens the Review
 * modal in HIGHLIGHT mode. Apply (the inverse: remove everything not kept) happens
 * on accept in the modal.
 *
 * Channel split (KTD4/KTD5): a duration budget runs the deterministic, contiguity-
 * aware selection (a watchable short); WITHOUT a budget the LLM keep-pass is the
 * primary taste channel (its keep ops ∪ the emphasis floor). Text-only, so it
 * degrades to the deterministic floor when no/limited LLM is configured.
 *
 * Browser-only (audio decode + fetch) — verified live, not under bun; the pure
 * scoring/selection/preview are tested separately.
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
import { buildAiAuthHeaders } from "@/features/ai-generate/store";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditorCore } from "@/core";
import { computeEnergyEnvelope, computeSpeechFeatures } from "./audio-features";
import { buildSignalTable } from "./build-signal-table";
import { useDirectorPlanStore } from "./director-plan-store";
import { useDirectorTasteStore } from "./taste";
import { scoreImportance } from "./importance";
import { buildHighlightKeeps, type KeepSpan } from "./keep-select";
import { snapKeepSpans } from "./snap-cut";

/**
 * Plan a Highlight cut and open the Review modal in highlight mode. Resolves once
 * the plan is on screen (apply is the modal's job). Throws "Cancelled" if aborted;
 * throws a typed message on no-speech (the caller surfaces it).
 */
export async function runHighlight({
	editor,
	budgetSec,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	/** Optional target length ("~Ns short"); absent = keep all the good parts. */
	budgetSec?: number;
	onProgress?: (detail: string) => void;
	signal?: AbortSignal;
}): Promise<void> {
	const abort = () => {
		if (signal?.aborted) throw new Error("Cancelled");
	};

	// Only assemble the whole bin onto an EMPTY timeline; otherwise highlight
	// exactly the clips the user already placed (don't pull in the rest of the bin).
	if (!timelineHasContent({ editor })) {
		onProgress?.("Assembling your footage...");
		assembleBinToTimeline({ editor, assets: editor.media.getAssets() });
	}
	abort();

	onProgress?.("Removing silences...");
	await runRemoveSilences({ editor });
	abort();

	onProgress?.("Transcribing...");
	const { segments } = await ensureTimelineTranscript({
		editor,
		signal,
		wantWords: true,
		onProgress: (p) => onProgress?.(p.detail),
	});
	if (!segments.length) {
		throw new Error("No speech found — Highlight needs a transcript.");
	}
	abort();

	onProgress?.("Scoring the best parts...");
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
	// Compute the energy envelope ONCE — shared by the per-segment features and the
	// keep-span snap below (avoids a redundant O(n) pass + a windowing mismatch).
	const envelope = computeEnergyEnvelope({ samples, sampleRate });
	const features = computeSpeechFeatures({ segments, envelope });
	const importance = scoreImportance({ segments, features });
	const totalSec = (totalDuration as number) / TICKS_PER_SECOND;
	abort();

	// LLM keep-pass — PRIMARY for the un-budgeted "keep the best" highlight (it can
	// recognize taste the score can't). For a budgeted short the deterministic
	// contiguity-aware selection drives it, so the LLM call is skipped.
	const llmKeepSpans: KeepSpan[] = [];
	if (budgetSec === undefined) {
		onProgress?.("Finding the keepers...");
		const signalTable = buildSignalTable({
			segments,
			features,
			elements: tracks.main.elements,
			importance,
		});
		const taste = useDirectorTasteStore.getState().buildDirectorTasteNote();
		try {
			const res = await fetch("/api/director/plan", {
				method: "POST",
				headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
				signal,
				body: JSON.stringify({ segments: signalTable, totalSec, taste: taste || undefined }),
			});
			if (res.ok) {
				const data = await res.json();
				const planOps = Array.isArray(data?.plan?.operations) ? data.plan.operations : [];
				for (const op of planOps) {
					if (op?.op === "keep") {
						const startSec = Number(op.startSec);
						const endSec = Number(op.endSec);
						if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
							llmKeepSpans.push({ startSec, endSec });
						}
					}
				}
			}
		} catch {
			// Degrade silently to the deterministic emphasis floor.
		}
		abort();
	}

	onProgress?.("Building the highlight...");
	const { keeps, preview } = buildHighlightKeeps({
		segments,
		importance,
		totalSec,
		budgetSec,
		llmKeepSpans,
	});
	// Issue E (Highlight): expand each kept span's edges to nearby low-energy troughs
	// so the cuts AROUND it land in the quiet, not mid-word. Directional (out-only) so
	// a keep never shrinks into a word — at worst it keeps a few frames more silence.
	// Reuses the envelope computed above.
	const snappedKeeps = snapKeepSpans({ spans: keeps, envelope });
	// Re-derive the kept-seconds preview from the snapped spans (count is unchanged).
	const keptSec = snappedKeeps.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
	// Attach a transcript snippet (the first segment opening each kept span) for the rows.
	const keepRows = snappedKeeps.map((k) => ({
		startSec: k.startSec,
		endSec: k.endSec,
		text: segments.find((s) => s.start >= k.startSec - 0.001 && s.start < k.endSec)?.text,
	}));
	useDirectorPlanStore
		.getState()
		.openHighlight({ keeps: keepRows, preview: { ...preview, keptSec }, totalSec });
}
