/**
 * AI auto-assemble (FrameCut, P4): one-click rough cut from the WHOLE bin.
 *
 * Transcribes every bin clip (P0) → cross-bin candidate pool + take clusters (P1)
 * → the LLM picks + orders the best spans (P2, /api/director/assemble) → lays them
 * on the active scene's main track as one undoable command (P3). Non-destructive
 * in the sense that one Ctrl+Z reverts the whole draft.
 */

import type { EditorCore } from "@/core";
import { TICKS_PER_SECOND } from "@/wasm";
import { buildAiAuthHeaders } from "@/features/ai-generate/store";
import { RebuildMainTrackCommand } from "@/commands/timeline/element/rebuild-main-track";
import type { AssemblyPlan } from "@framecut/hf-bridge";
import { transcribeBin } from "./asset-transcribe";
import { buildCandidatePool } from "./candidate-pool";
import { buildTakeClustersFromPool } from "./take-clusters";
import {
	buildAssemblyCandidates,
	resolveAssemblySpanInputs,
} from "./assembly-candidates";
import { planMainTrackElements } from "./assembly-placement";
import { useDirectorTasteStore } from "./taste";

export interface RunAssembleResult {
	/** Number of spans placed on the main track. */
	placed: number;
	/** The model's one-line read of the story, when it returned one. */
	narrative?: string;
}

export async function runAssemble({
	editor,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	onProgress?: (detail: string) => void;
	signal?: AbortSignal;
}): Promise<RunAssembleResult> {
	const assets = editor.media.getAssets();

	onProgress?.("Transcribing your footage...");
	const clips = await transcribeBin({
		assets,
		signal,
		onProgress: (p) =>
			onProgress?.(
				`Transcribing ${p.index + 1}/${p.total}: ${p.assetName}${p.cached ? " (cached)" : ""}`,
			),
	});
	if (clips.length === 0) {
		throw new Error("No speech found in the bin to assemble.");
	}

	onProgress?.("Comparing takes...");
	const pool = buildCandidatePool({ clips });
	const clusters = buildTakeClustersFromPool({ pool });
	const candidates = buildAssemblyCandidates({
		pool,
		clusters,
		clipNameByAssetId: new Map(assets.map((a) => [a.id, a.name])),
	});

	onProgress?.("Assembling the best cut...");
	const taste = useDirectorTasteStore.getState().buildDirectorTasteNote();
	const res = await fetch("/api/director/assemble", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		signal,
		body: JSON.stringify({ candidates, taste: taste || undefined }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => null);
		throw new Error(err?.error ?? `Assembly failed (${res.status})`);
	}
	const data = await res.json();
	const plan: AssemblyPlan =
		data?.plan && Array.isArray(data.plan.spans) ? data.plan : { spans: [] };

	onProgress?.("Placing the cut...");
	const spanInputs = resolveAssemblySpanInputs({
		planSpans: plan.spans,
		assetInfoById: new Map(
			assets.map((a) => [a.id, { name: a.name, durationSec: a.duration ?? 0 }]),
		),
	});
	const specs = planMainTrackElements({
		spans: spanInputs,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	if (specs.length === 0) {
		throw new Error("The assembler chose no usable spans.");
	}

	editor.command.execute({ command: new RebuildMainTrackCommand({ specs }) });
	return {
		placed: specs.length,
		...(plan.narrative ? { narrative: plan.narrative } : {}),
	};
}
