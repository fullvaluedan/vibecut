/**
 * "Run through HyperFrames" on a SPECIFIC clip from the timeline (right-click
 * entry). The HyperFrames panel is a PROMPT GENERATOR: the user's selections +
 * active look + direction + the clip's transcript compile into a brief, Claude
 * AUTHORS a custom composition for it (via /api/hyperframes/author — text
 * output, the product writes + renders), and the result lands on a NEW track
 * over the segment, never overwriting the footage (see place-hyperframes-render).
 */

import { toast } from "sonner";
import type { EditorCore } from "@/core";
import type { VideoElement } from "@/timeline";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	useAiSettingsStore,
	buildAiAuthHeaders,
} from "@/features/ai-generate/store";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { getStyleById } from "@/features/ai-generate/styles";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import {
	getCachedTranscript,
	ensureTimelineTranscript,
} from "@/features/transcription/transcript-cache";
import {
	compileHyperframesPrompt,
	type HfSelectionAsset,
} from "@/features/ai-generate/compile-hyperframes-prompt";
import {
	placeHyperframesRender,
	placeHyperframesRenders,
	type HyperframesRenderScope,
} from "@/features/ai-generate/place-hyperframes-render";
import { useRunLogStore, logRun } from "@/features/ai-generate/run-log-store";
import { runWithConcurrency } from "@/features/ai-generate/concurrency";
import {
	planAuthorChunks,
	VARIANT_CHUNK_SEC,
	type AuthorChunk,
} from "@/features/ai-generate/chunk-plan";
import type { RunProgress } from "@/features/ai-generate/run-hyperframes";

/** Enabled native templates → selection hints for the author brief. */
function enabledSelections(): HfSelectionAsset[] {
	const disabled = useAiSettingsStore.getState().disabledTemplateIds;
	return describeTemplateCatalog()
		.filter((t) => !disabled.includes(t.id))
		.map((t) => ({
			name: t.id,
			kind: "template" as const,
			title: t.id,
			description: t.whenToUse,
		}));
}

/**
 * The registry assets the user explicitly PICKED for the brief (allow-list),
 * resolved to their titles/descriptions via the registry. Best-effort — a
 * fetch failure just means those picks aren't named in the brief.
 */
async function pickedRegistrySelections(): Promise<HfSelectionAsset[]> {
	const picks = useAiSettingsStore.getState().promptHfAssets;
	if (!picks.length) return [];
	try {
		const res = await fetch("/api/hyperframes/registry");
		if (!res.ok) return [];
		const data = (await res.json()) as {
			items?: {
				name: string;
				type: string;
				title: string;
				description: string;
				tags?: string[];
			}[];
		};
		const all = data.items ?? [];
		const want = new Set(picks);
		return all
			.filter((a) => want.has(a.name))
			.map((a) => {
				const kind = a.type.split(":")[1];
				return {
					name: a.name,
					kind: (kind === "block" || kind === "component" || kind === "example"
						? kind
						: "block") as HfSelectionAsset["kind"],
					title: a.title,
					description: a.description,
					// Examples are whole-video templates; flag them so the brief
					// tells the author they REFRAME the footage.
					fullFrame: kind === "example" ? true : undefined,
				};
			});
	} catch {
		return [];
	}
}

const MAX_REFERENCE_COMPS = 3;

/**
 * Fetch the REAL composition HTML for the user's picked registry assets (capped),
 * so the author adapts the genuine asset instead of reinventing it from a name.
 * Best-effort: a fetch failure drops that reference (the pick still appears as a
 * named preference). The server route does the cross-origin registry fetch.
 */
async function fetchReferenceCompositions(
	picks: HfSelectionAsset[],
): Promise<{ name: string; title: string; html: string }[]> {
	const want = picks.slice(0, MAX_REFERENCE_COMPS);
	const fetched = await Promise.all(
		want.map(async (p) => {
			try {
				const res = await fetch("/api/hyperframes/registry-comp", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: p.name, type: `hyperframes:${p.kind}` }),
				});
				if (!res.ok) return null;
				const data = (await res.json()) as { title?: string; html?: string };
				return data.html
					? { name: p.name, title: p.title, html: data.html }
					: null;
			} catch {
				return null;
			}
		}),
	);
	return fetched.filter(
		(c): c is { name: string; title: string; html: string } => c !== null,
	);
}

/** Segments scoped to [startSec, endSec], offset to 0, as bracketed text. */
function scopeSegments(
	segments: { start: number; end: number; text: string }[],
	startSec: number,
	endSec: number,
): string {
	return segments
		.filter((s) => s.end > startSec && s.start < endSec)
		.map(
			(s) =>
				`[${Math.max(0, s.start - startSec).toFixed(1)}–${Math.max(
					0,
					s.end - startSec,
				).toFixed(1)}] ${s.text.trim()}`,
		)
		.join("\n");
}

/** Does the timeline have any audio worth transcribing? */
function timelineHasAudio(editor: EditorCore): boolean {
	const t = editor.scenes.getActiveScene().tracks;
	if (t.audio.some((tr) => tr.elements.length > 0)) return true;
	return [t.main, ...t.overlay].some((tr) =>
		tr.elements.some(
			(e) => e.type === "video" && e.isSourceAudioEnabled !== false,
		),
	);
}

/**
 * Transcript for the clip so the authored graphic reflects what's SAID in it.
 * Transcribes on demand (cached after the first run) when the timeline has
 * audio; otherwise best-effort from cache. Never blocks authoring — a failure
 * just means the graphic is authored from the selections + look alone.
 */
async function gatherClipTranscript(
	editor: EditorCore,
	startSec: number,
	endSec: number,
	signal?: AbortSignal,
): Promise<string> {
	if (timelineHasAudio(editor)) {
		try {
			const { segments } = await ensureTimelineTranscript({
				editor,
				onProgress: (p) => logRun(`${p.phase}: ${p.detail}`),
				signal,
			});
			return scopeSegments(segments, startSec, endSec);
		} catch (e) {
			// A user cancel during transcription must abort the whole run — only
			// a genuine transcript failure falls through to best-effort cache.
			if (signal?.aborted) throw e;
			logRun(
				`(transcript skipped: ${e instanceof Error ? e.message : String(e)})`,
				"warn",
			);
		}
	}
	return scopeSegments(getCachedTranscript(editor) ?? [], startSec, endSec);
}

let clipRunInFlight = false;

export async function runHyperframesOnClip({
	editor,
	element,
}: {
	editor: EditorCore;
	/** The right-clicked clip. */
	element: VideoElement;
}): Promise<void> {
	// Re-entrancy guard: the context-menu entry has no isRunning gate, so a
	// double-click would fire two concurrent authors (double tokens, duplicate
	// graphic). One at a time.
	if (clipRunInFlight) {
		toast.info("A HyperFrames run is already in progress", {
			description: "Wait for it to finish or cancel it first.",
		});
		return;
	}
	clipRunInFlight = true;
	const startSec = element.startTime / TICKS_PER_SECOND;
	const endSec = (element.startTime + element.duration) / TICKS_PER_SECOND;
	const scope: HyperframesRenderScope = {
		kind: "clip",
		label: element.name?.trim() || "clip",
		startSec,
	};

	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	const durationSec = Math.min(Math.max(endSec - startSec, 3), 10);
	const { styleId, hfDirection } = useAiSettingsStore.getState();
	const look = getStyleById(styleId);

	const controller = new AbortController();
	const toastId = toast.loading(
		`HyperFrames is authoring a graphic for "${scope.label}"...`,
		{ action: { label: "Cancel", onClick: () => controller.abort() } },
	);
	useRunLogStore.getState().setOpen(true);
	logRun(`▶ Run through HyperFrames on "${scope.label}"`);
	try {
		const transcript = await gatherClipTranscript(
			editor,
			startSec,
			endSec,
			controller.signal,
		);
		const registrySelections = await pickedRegistrySelections();
		const referenceCompositions =
			await fetchReferenceCompositions(registrySelections);
		const prompt = compileHyperframesPrompt({
			selections: [...enabledSelections(), ...registrySelections],
			referenceCompositions,
			look: {
				name: look.name,
				description: look.description,
				accent: look.accent,
				fontFamily: look.fontFamily,
			},
			direction: hfDirection,
			scope: { kind: "clip", label: `clip "${scope.label}"`, startSec, endSec },
			transcript,
			canvas: { width, height, fps },
			preferenceNotes: usePreferenceStore
				.getState()
				.buildPreferenceNotes("graphics"),
		});
		logRun("Authoring a custom graphic with Claude (this can take ~30–60s)…");
		const res = await fetch("/api/hyperframes/author", {
			method: "POST",
			headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
			body: JSON.stringify({ prompt, fps, width, height, durationSec }),
			signal: controller.signal,
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => null)) as {
				error?: string;
			} | null;
			throw new Error(err?.error ?? `Author failed (${res.status})`);
		}
		const compId = res.headers.get("x-framecut-comp-id") ?? undefined;
		const tokens = Number(res.headers.get("x-framecut-tokens")) || 0;
		if (tokens > 0) useAiSettingsStore.getState().addTokensUsed(tokens);
		logRun("Composition rendered. Placing on a new track…");
		const blob = await res.blob();
		const file = new File([blob], "hf-authored-clip.webm", {
			type: "video/webm",
		});

		// The fetch can resolve a hair before the abort lands (cancel clicked as
		// the bytes arrive); re-check so we don't place a graphic the user cancelled.
		if (controller.signal.aborted) throw new Error("Cancelled");

		const placed = await placeHyperframesRender({
			editor,
			file,
			scope,
			compId,
			templateId: `authored:${compId ?? "clip"}`,
			name: `HyperFrames: ${scope.label}`,
		});
		// Self-learning: an authored graphic landed — a later delete is the
		// "didn't like it" signal that balances this against the keep count.
		usePreferenceStore.getState().noteGraphicsPlaced();

		logRun(
			`✓ landed on a new track over "${scope.label}" at ${placed.startSec.toFixed(1)}s`,
		);
		toast.success(
			`Landed on a new track over "${scope.label}" at ${placed.startSec.toFixed(1)}s`,
			{
				id: toastId,
				description: placed.splitAudio
					? "Sound effects split to a new audio track below."
					: "Edit it in HyperFrames Studio, then re-render.",
			},
		);
	} catch (e) {
		if (controller.signal.aborted) {
			logRun("■ cancelled by user", "warn");
			toast.info("HyperFrames run cancelled", {
				id: toastId,
				description: "Stopped the author; nothing was placed on the timeline.",
			});
			return;
		}
		const message = e instanceof Error ? e.message : String(e);
		logRun(`✗ ${message}`, "error");
		toast.error("HyperFrames run failed", {
			id: toastId,
			description: message,
		});
	} finally {
		clipRunInFlight = false;
	}
}

// --- Chunked authoring: cover the WHOLE video, one short composition per
// segment, so a long video gets graphics throughout (not one sparse opener)
// and each `claude -p` call stays small/fast. Renders serialize globally in
// the bridge (one headless browser at a time). Chunk math lives in the pure
// chunk-plan module so it's unit-testable without editor deps. ---

interface SharedAuthorInputs {
	segments: { start: number; end: number; text: string }[];
	selections: HfSelectionAsset[];
	look: {
		name: string;
		description: string;
		accent?: string;
		fontFamily?: string;
	};
	direction: string;
	canvas: { width: number; height: number; fps: number };
	preferenceNotes: string[];
	referenceCompositions: { name: string; title: string; html: string }[];
}

/** Transcribe once + gather the selections/look/direction shared by every chunk. */
async function buildSharedInputs({
	editor,
	totalSec,
	signal,
}: {
	editor: EditorCore;
	totalSec: number;
	signal?: AbortSignal;
}): Promise<SharedAuthorInputs> {
	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	// Warm the transcript cache once; chunks slice from it via scopeSegments.
	await gatherClipTranscript(editor, 0, totalSec, signal);
	const segments = getCachedTranscript(editor) ?? [];
	const registrySelections = await pickedRegistrySelections();
	const referenceCompositions =
		await fetchReferenceCompositions(registrySelections);
	const { styleId, hfDirection } = useAiSettingsStore.getState();
	const look = getStyleById(styleId);
	return {
		segments,
		selections: [...enabledSelections(), ...registrySelections],
		referenceCompositions,
		look: {
			name: look.name,
			description: look.description,
			accent: look.accent,
			fontFamily: look.fontFamily,
		},
		direction: hfDirection,
		canvas: { width, height, fps },
		preferenceNotes: usePreferenceStore
			.getState()
			.buildPreferenceNotes("graphics"),
	};
}

interface AuthoredChunkRender {
	chunk: AuthorChunk;
	file: File;
	compId?: string;
}

/** Author every chunk (bounded concurrency); local renders serialize in the bridge. */
async function authorChunks({
	chunks,
	shared,
	angle,
	concurrency,
	signal,
	labelPrefix,
	onChunkDone,
}: {
	chunks: AuthorChunk[];
	shared: SharedAuthorInputs;
	/** A distinct creative angle appended to the brief (variant mode). */
	angle?: string;
	concurrency: number;
	signal?: AbortSignal;
	labelPrefix?: string;
	onChunkDone?: (done: number, total: number) => void;
}): Promise<{
	rendered: AuthoredChunkRender[];
	skipped: string[];
	tokensUsed: number;
}> {
	const rendered: AuthoredChunkRender[] = [];
	const skipped: string[] = [];
	let tokensUsed = 0;
	let done = 0;
	const pre = labelPrefix ? `${labelPrefix} ` : "";

	await runWithConcurrency(chunks, concurrency, async (chunk) => {
		if (signal?.aborted) throw new Error("Cancelled");
		const chunkLen = chunk.endSec - chunk.startSec;
		const transcript = scopeSegments(
			shared.segments,
			chunk.startSec,
			chunk.endSec,
		);
		const direction = angle
			? `${shared.direction}\n\nVARIANT ANGLE (make this version distinct): ${angle}`.trim()
			: shared.direction;
		const prompt = compileHyperframesPrompt({
			selections: shared.selections,
			referenceCompositions: shared.referenceCompositions,
			look: shared.look,
			direction,
			scope: {
				kind: "timeline",
				label: `segment ${chunk.label}`,
				startSec: 0,
				endSec: chunkLen,
			},
			transcript,
			canvas: shared.canvas,
			preferenceNotes: shared.preferenceNotes,
			densityHint: `Aim for ~${Math.max(1, Math.round(chunkLen / 15))} timed graphics across this ${Math.round(chunkLen)}s segment — spread them out, at least one early.`,
		});
		try {
			logRun(
				`${pre}authoring segment ${chunk.index + 1}/${chunks.length} (${chunk.label})…`,
			);
			const res = await fetch("/api/hyperframes/author", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...buildAiAuthHeaders(),
				},
				body: JSON.stringify({
					prompt,
					fps: shared.canvas.fps,
					width: shared.canvas.width,
					height: shared.canvas.height,
					durationSec: chunkLen,
				}),
				signal,
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(err?.error ?? `Author failed (${res.status})`);
			}
			const compId = res.headers.get("x-framecut-comp-id") ?? undefined;
			tokensUsed += Number(res.headers.get("x-framecut-tokens")) || 0;
			const blob = await res.blob();
			rendered.push({
				chunk,
				compId,
				file: new File([blob], `hf-authored-${chunk.index}.webm`, {
					type: "video/webm",
				}),
			});
			logRun(`${pre}✓ segment ${chunk.index + 1}/${chunks.length} ready`);
		} catch (e) {
			// A user cancel aborts the whole run; a single bad segment is skipped.
			if (signal?.aborted) throw e;
			const msg = e instanceof Error ? e.message : String(e);
			skipped.push(`segment ${chunk.label}: ${msg}`);
			logRun(`${pre}✗ segment ${chunk.label}: ${msg}`, "warn");
		} finally {
			done++;
			onChunkDone?.(done, chunks.length);
		}
	});

	rendered.sort((a, b) => a.chunk.startSec - b.chunk.startSec);
	return { rendered, skipped, tokensUsed };
}

/** claude-code spawns a local CLI per call → 1; hosted endpoints parallelize → 2. */
function authorConcurrency(): number {
	return useAiSettingsStore.getState().authMode === "claude-code" ? 1 : 2;
}

/**
 * RUN HYPERFRAMES "authored" engine: split the video into ~90s segments, author
 * a graphic-rich composition for each, and place them across the WHOLE timeline
 * on one new overlay track. Renders run one-at-a-time (bridge render queue) so a
 * long video stays light on the machine. Same progress/result shape as
 * runHyperframes so the toolbar button can call either.
 */
export async function runHyperframesWholeTimeline({
	editor,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	onProgress: (p: RunProgress) => void;
	signal?: AbortSignal;
}): Promise<{ placed: number; skipped: string[]; tokensUsed: number }> {
	const totalSec = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	if (totalSec < 1) {
		throw new Error("Add some footage to the timeline first.");
	}
	const chunks = planAuthorChunks(totalSec);

	useRunLogStore.getState().setOpen(true);
	logRun(
		`▶ RUN HYPERFRAMES — authoring graphics across the whole video (${chunks.length} segment${chunks.length === 1 ? "" : "s"})`,
	);

	onProgress({ stage: "transcribing", detail: "Reading the timeline…" });
	const shared = await buildSharedInputs({ editor, totalSec, signal });

	onProgress({
		stage: "rendering",
		detail: `Authoring graphics segment 1/${chunks.length}…`,
		effectIndex: 1,
		effectCount: chunks.length,
	});
	const { rendered, skipped, tokensUsed } = await authorChunks({
		chunks,
		shared,
		concurrency: authorConcurrency(),
		signal,
		onChunkDone: (doneCount) =>
			onProgress({
				stage: "rendering",
				detail: `Authored ${doneCount}/${chunks.length} segments…`,
				effectIndex: Math.min(doneCount + 1, chunks.length),
				effectCount: chunks.length,
			}),
	});
	if (tokensUsed > 0) useAiSettingsStore.getState().addTokensUsed(tokensUsed);
	if (signal?.aborted) throw new Error("Cancelled");

	onProgress({
		stage: "placing",
		detail: "Placing graphics on a new track…",
		effectIndex: chunks.length,
		effectCount: chunks.length,
	});
	const placed = await placeHyperframesRenders({
		editor,
		renders: rendered.map((r) => ({
			file: r.file,
			startSec: r.chunk.startSec,
			compId: r.compId,
			templateId: `authored:${r.compId ?? r.chunk.index}`,
			name: `HyperFrames: ${r.chunk.label}`,
		})),
	});
	if (placed > 0) usePreferenceStore.getState().noteGraphicsPlaced();
	logRun(
		`✓ placed ${placed} graphic segment${placed === 1 ? "" : "s"} across the video`,
	);
	onProgress({
		stage: "done",
		detail: `Placed ${placed} graphic segment${placed === 1 ? "" : "s"} across the video.`,
	});
	return { placed, skipped, tokensUsed };
}

/** Distinct creative angles for the variant picker (one whole-video pass each). */
const VARIANT_ANGLES = [
	"bold / high-energy — punchy kinetic titles, strong accent color, fast moves",
	"restrained / editorial — calm lower-thirds and section breaks, minimal motion",
	"minimal / typographic — clean type, lots of negative space, subtle fades",
	"playful / dynamic — lively pills and number pops, energetic but tasteful",
	"data-forward — emphasize numbers, stats, and labeled callouts",
];

export interface AuthoredVersion {
	index: number;
	angle: string;
	renders: AuthoredChunkRender[];
	skipped: string[];
}

/**
 * Variant picker: author N distinct whole-video passes (coarser chunks to bound
 * total renders), each with its own creative angle. Renders still go one-at-a-time
 * through the bridge queue. Returns the versions WITHOUT placing — the caller
 * shows a picker and places the chosen one via placeHyperframesRenders.
 */
export async function runHyperframesVariants({
	editor,
	count = 3,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	count?: number;
	onProgress: (p: RunProgress) => void;
	signal?: AbortSignal;
}): Promise<{ versions: AuthoredVersion[]; tokensUsed: number }> {
	const totalSec = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	if (totalSec < 1) {
		throw new Error("Add some footage to the timeline first.");
	}
	const n = Math.min(Math.max(count, 1), VARIANT_ANGLES.length);
	const chunks = planAuthorChunks(totalSec, VARIANT_CHUNK_SEC);

	useRunLogStore.getState().setOpen(true);
	logRun(
		`▶ RUN HYPERFRAMES — generating ${n} versions (${chunks.length} segment${chunks.length === 1 ? "" : "s"} each, rendered one at a time)`,
	);

	onProgress({ stage: "transcribing", detail: "Reading the timeline…" });
	const shared = await buildSharedInputs({ editor, totalSec, signal });

	const versions: AuthoredVersion[] = [];
	let tokensUsed = 0;
	const totalUnits = n * chunks.length;
	let unitsDone = 0;

	// Versions run sequentially for clear progress + bounded model load; the
	// render queue serializes the heavy local work regardless.
	for (let i = 0; i < n; i++) {
		if (signal?.aborted) throw new Error("Cancelled");
		const angle = VARIANT_ANGLES[i];
		logRun(`— Version ${i + 1}/${n}: ${angle.split(" — ")[0]}`);
		const {
			rendered,
			skipped,
			tokensUsed: t,
		} = await authorChunks({
			chunks,
			shared,
			angle,
			concurrency: authorConcurrency(),
			signal,
			labelPrefix: `v${i + 1}`,
			onChunkDone: () => {
				unitsDone++;
				onProgress({
					stage: "rendering",
					detail: `Version ${i + 1}/${n} — ${unitsDone}/${totalUnits} segments…`,
					effectIndex: unitsDone,
					effectCount: totalUnits,
				});
			},
		});
		tokensUsed += t;
		versions.push({ index: i, angle, renders: rendered, skipped });
	}
	if (tokensUsed > 0) useAiSettingsStore.getState().addTokensUsed(tokensUsed);
	if (signal?.aborted) throw new Error("Cancelled");

	const usable = versions.filter((v) => v.renders.length > 0);
	if (!usable.length) {
		throw new Error("No versions could be generated — check the run log.");
	}
	logRun(`✓ ${usable.length} version(s) ready — pick one to place`);
	onProgress({
		stage: "done",
		detail: `${usable.length} version${usable.length === 1 ? "" : "s"} ready — pick one.`,
	});
	return { versions: usable, tokensUsed };
}
