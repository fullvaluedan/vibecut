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
	resolveDesignSpec,
} from "@/features/ai-generate/store";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { getStyleById } from "@/features/ai-generate/styles";
import {
	describeDesignSpec,
	type HfDesignProfile,
} from "@/features/ai-generate/profiles";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import {
	getCachedTranscript,
	ensureTimelineTranscript,
} from "@/features/transcription/transcript-cache";
import {
	compileHyperframesPrompt,
	prioritizeFormPicks,
	type HfSelectionAsset,
} from "@/features/ai-generate/compile-hyperframes-prompt";
import { detectSpeakerZone } from "@/features/ai-generate/detect-speaker-zone";
import {
	placeHyperframesRender,
	placeHyperframesRenders,
	type ChunkRenderInput,
	type HyperframesRenderScope,
} from "@/features/ai-generate/place-hyperframes-render";
import { useRunLogStore, logRun } from "@/features/ai-generate/run-log-store";
import { runWithConcurrency } from "@/features/ai-generate/concurrency";
import {
	planAuthorChunks,
	planAuthorChunksOver,
	VARIANT_CHUNK_SEC,
	fmtRange,
	type AuthorChunk,
} from "@/features/ai-generate/chunk-plan";
import type { RunProgress } from "@/features/ai-generate/run-hyperframes";
import {
	scopeSegments,
	hasAuthorableContent,
} from "@/features/ai-generate/transcript-scope";
import {
	createRunManifest,
	markApproved,
	matchReusableChunks,
	transitionChunk,
	type ManifestChunk,
	type RunManifest,
} from "@framecut/hf-bridge/run-manifest";
import {
	probeDurationSec,
	runIdForScope,
	canStartFullRender,
} from "@/features/ai-generate/probe-plan";
import {
	useVariantPickerStore,
	type ProbeDraft,
} from "@/features/ai-generate/variant-picker-store";

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

interface BriefLook {
	name: string;
	description: string;
	accent?: string;
	fontFamily?: string;
}

/**
 * The look + optional design profile for a run's brief. With no active
 * profile this is exactly the factory look, as before; with one, the look
 * line reflects the profile and the structured DESIGN PROFILE section rides
 * along so the skill honors palette/fonts/motion/density as a set.
 */
function resolveBriefDesign(): {
	look: BriefLook;
	designProfile?: HfDesignProfile;
} {
	const state = useAiSettingsStore.getState();
	const design = resolveDesignSpec(state);
	if (!design.custom) {
		const look = getStyleById(state.styleId);
		return {
			look: {
				name: look.name,
				description: look.description,
				accent: look.accent,
				fontFamily: look.fontFamily,
			},
		};
	}
	return {
		look: {
			name: design.name,
			description: `Saved style profile: ${describeDesignSpec(design.spec)}`,
			accent: design.spec.palette.accent,
			fontFamily: design.spec.fonts.display,
		},
		designProfile: { name: design.name, spec: design.spec },
	};
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
	signal?: AbortSignal,
): Promise<{ name: string; title: string; html: string }[]> {
	// Prioritize FORM relevance, not list order, so the few fetched references are
	// the forms the content->form rubric actually uses (see prioritizeFormPicks).
	const want = prioritizeFormPicks(picks, MAX_REFERENCE_COMPS);
	const fetched = await Promise.all(
		want.map(async (p) => {
			try {
				const res = await fetch("/api/hyperframes/registry-comp", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: p.name, type: `hyperframes:${p.kind}` }),
					signal,
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
 * Raw timeline transcript segments: transcribe on demand (cached after the
 * first run) when the timeline has audio; otherwise best-effort from cache.
 * Never blocks authoring — a failure falls through to whatever is cached. The
 * RAW segments let callers slice any window AND check whether there is ANY
 * speech to author from (an empty result is the real cause of the "no
 * transcript" author failures).
 */
async function gatherTimelineSegments(
	editor: EditorCore,
	signal?: AbortSignal,
): Promise<{ start: number; end: number; text: string }[]> {
	if (timelineHasAudio(editor)) {
		try {
			// Collapse the per-second "…Ns elapsed" tickers (initializing-model,
			// transcribing repeat the same phase with a changing elapsed count) to one
			// line each, but let the model-download phase's live percentage through — a
			// fresh ~40MB download is the one long first-run step where visible progress
			// matters, and it repeats the same phase with a changing "% downloaded".
			let lastPhase = "";
			let lastDetail = "";
			const { segments } = await ensureTimelineTranscript({
				editor,
				onProgress: (p) => {
					const carriesProgress = p.phase === "downloading-model";
					if (
						p.phase === lastPhase &&
						!(carriesProgress && p.detail !== lastDetail)
					) {
						return;
					}
					lastPhase = p.phase;
					lastDetail = p.detail;
					logRun(`${p.phase}: ${p.detail}`);
				},
				signal,
			});
			return segments;
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
	return getCachedTranscript(editor) ?? [];
}

/** Clip transcript: the raw segments scoped to [startSec, endSec], offset to 0. */
async function gatherClipTranscript(
	editor: EditorCore,
	startSec: number,
	endSec: number,
	signal?: AbortSignal,
): Promise<string> {
	return scopeSegments(
		await gatherTimelineSegments(editor, signal),
		startSec,
		endSec,
	);
}

/**
 * Graphics recap SPOKEN content, so a run with NO transcript AND no user
 * direction has nothing to author — every chunk would spawn a `claude -p` that
 * correctly refuses ("(no speech in this segment)"). Fail fast with the actual
 * reason instead of flooding the log with N identical refusals.
 */
function noAuthorableContentError(editor: EditorCore): Error {
	return new Error(
		timelineHasAudio(editor)
			? "No speech was found in this video, so there's nothing to recap. If it has talking, the transcript came back empty — try Settings → AI → cloud transcription, or type a direction in the HyperFrames panel to author from. (Music-only clips have nothing to caption.)"
			: "No audio is enabled on the timeline. HyperFrames graphics recap what's SAID — enable the clip's source audio (or add its audio track), or type a direction in the HyperFrames panel, then run again.",
	);
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
	const { hfDirection } = useAiSettingsStore.getState();
	const briefDesign = resolveBriefDesign();

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
		// Nothing said in this clip and no direction to author from → the skill
		// would just refuse. Fail fast with the reason instead of a doomed author.
		if (!hasAuthorableContent(transcript, hfDirection)) {
			throw noAuthorableContentError(editor);
		}
		const registrySelections = await pickedRegistrySelections();
		const referenceCompositions = await fetchReferenceCompositions(
			registrySelections,
			controller.signal,
		);
		// Speaker-aware placement: when Director Vision is on, locate the speaker in
		// this clip's footage so the brief can keep clear of them (and their path).
		// Best-effort — null falls back to the brief's robust lower-third default.
		const speakerSafeZone = useAiSettingsStore.getState().directorVisionEnabled
			? ((await detectSpeakerZone({
					editor,
					element,
					signal: controller.signal,
				})) ?? undefined)
			: undefined;
		const prompt = compileHyperframesPrompt({
			selections: [...enabledSelections(), ...registrySelections],
			referenceCompositions,
			look: briefDesign.look,
			designProfile: briefDesign.designProfile,
			direction: hfDirection,
			scope: { kind: "clip", label: `clip "${scope.label}"`, startSec, endSec },
			transcript,
			canvas: { width, height, fps },
			speakerSafeZone,
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
			brief: prompt,
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
	/** Present only when a user style profile is active. */
	designProfile?: HfDesignProfile;
	direction: string;
	canvas: { width: number; height: number; fps: number };
	preferenceNotes: string[];
	referenceCompositions: { name: string; title: string; html: string }[];
}

/** Transcribe once + gather the selections/look/direction shared by every chunk. */
async function buildSharedInputs({
	editor,
	signal,
}: {
	editor: EditorCore;
	signal?: AbortSignal;
}): Promise<SharedAuthorInputs> {
	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	// One transcription for the whole run; chunks slice it via scopeSegments.
	const segments = await gatherTimelineSegments(editor, signal);
	const registrySelections = await pickedRegistrySelections();
	const referenceCompositions = await fetchReferenceCompositions(
		registrySelections,
		signal,
	);
	const { hfDirection } = useAiSettingsStore.getState();
	const briefDesign = resolveBriefDesign();
	return {
		segments,
		selections: [...enabledSelections(), ...registrySelections],
		referenceCompositions,
		look: briefDesign.look,
		designProfile: briefDesign.designProfile,
		direction: hfDirection,
		canvas: { width, height, fps },
		preferenceNotes: usePreferenceStore
			.getState()
			.buildPreferenceNotes("graphics"),
	};
}

/**
 * R2 observability: log the transcript state ONCE per run so an empty transcript
 * is diagnosable from the run log — never produced (no segments) vs lost in
 * scoping (segments present but per-chunk char counts zero, logged in authorChunks).
 */
function logTranscriptSummary(segments: SharedAuthorInputs["segments"]): void {
	if (!segments.length) {
		logRun("transcript: no segments (nothing to author from)", "warn");
		return;
	}
	const first = segments[0].start;
	const last = segments[segments.length - 1].end;
	logRun(
		`transcript: ${segments.length} segment${
			segments.length === 1 ? "" : "s"
		}, ${first.toFixed(1)}s–${last.toFixed(1)}s`,
	);
}

interface AuthoredChunkRender {
	chunk: AuthorChunk;
	file: File;
	compId?: string;
	/** The compiled prompt for this chunk — carried onto the clip for re-editing. */
	brief?: string;
}

/**
 * The per-chunk brief both the full-render loop (authorChunks) and the probe
 * loop (probeChunks) compile: scoped transcript + prompt, or null when the
 * segment has nothing to author from.
 */
function compileChunkBrief({
	shared,
	chunk,
	angle,
}: {
	shared: SharedAuthorInputs;
	chunk: AuthorChunk;
	/** A distinct creative angle appended to the brief (variant mode). */
	angle?: string;
}): { transcript: string; prompt: string } | null {
	const chunkLen = chunk.endSec - chunk.startSec;
	const transcript = scopeSegments(
		shared.segments,
		chunk.startSec,
		chunk.endSec,
	);
	// A silent segment (gap, music, intro) has nothing to recap and the skill
	// would only refuse — skip it instead of a doomed author, unless the user
	// gave a direction to author from (an angle alone is not content).
	if (!hasAuthorableContent(transcript, shared.direction)) return null;
	const direction = angle
		? `${shared.direction}\n\nVARIANT ANGLE (make this version distinct): ${angle}`.trim()
		: shared.direction;
	const prompt = compileHyperframesPrompt({
		selections: shared.selections,
		referenceCompositions: shared.referenceCompositions,
		look: shared.look,
		designProfile: shared.designProfile,
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
		densityHint: `At most ~${Math.max(1, Math.round(chunkLen / 45))} SUBSTANTIVE graphics across this ${Math.round(chunkLen)}s segment — a recap list, a data chart, or an explanatory card, NOT title pills. Quality over quantity: a topic earns at most one strong graphic, held long enough to read. Make fewer (or none) rather than pad with labels.`,
	});
	return { transcript, prompt };
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
		const brief = compileChunkBrief({ shared, chunk, angle });
		if (!brief) {
			skipped.push(`segment ${chunk.label}: no speech in this segment`);
			logRun(`${pre}— skipped ${chunk.label} (no speech)`, "warn");
			done++;
			onChunkDone?.(done, chunks.length);
			return;
		}
		const { transcript, prompt } = brief;
		try {
			logRun(
				`${pre}authoring segment ${chunk.index + 1}/${chunks.length} (${chunk.label}) — ${transcript.trim().length} transcript chars…`,
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
				brief: prompt,
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

// --- Probe-render-first + resume guards: every chunked run probes each
// segment (the first ~4s), BLOCKS the full render until the probe set is
// approved, and checkpoints chunk state in a server-side run-manifest so a
// failed chunk retries (never silently dropped), a re-run of the same scope
// reuses rendered chunks, and a user cancel keeps them. The probe review
// rides the variant-picker/drafts machinery, not a new dialog family. ---

/** Load a run's checkpoint; the manifest is a resume optimization, never fatal. */
async function fetchRunManifest(runId: string): Promise<RunManifest | null> {
	try {
		const res = await fetch(
			`/api/hyperframes/run-manifest?runId=${encodeURIComponent(runId)}`,
		);
		if (!res.ok) return null;
		const data = (await res.json()) as { manifest?: RunManifest | null };
		return data.manifest ?? null;
	} catch {
		return null;
	}
}

/** Persist a checkpoint (best-effort). */
async function postRunManifest(manifest: RunManifest): Promise<void> {
	try {
		await fetch("/api/hyperframes/run-manifest", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest }),
		});
	} catch {
		// best-effort checkpoint
	}
}

/** Full-render one authored comp via the render-comp route (cache-reuses out.webm). */
async function renderCompViaRoute(
	compId: string,
	fps: number,
	signal: AbortSignal | undefined,
	chunkIndex: number,
): Promise<File> {
	const res = await fetch("/api/hyperframes/render-comp", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ compId, fps }),
		signal,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(err?.error ?? `Render failed (${res.status})`);
	}
	const blob = await res.blob();
	return new File([blob], `hf-render-${chunkIndex}.webm`, {
		type: "video/webm",
	});
}

/** Re-pull the cached probe of a chunk a previous identical run already authored. */
async function pullCachedProbe(
	chunk: AuthorChunk,
	compId: string,
	fps: number,
	signal?: AbortSignal,
): Promise<File> {
	const res = await fetch("/api/hyperframes/render-comp", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			compId,
			fps,
			probeSec: probeDurationSec(chunk.endSec - chunk.startSec),
		}),
		signal,
	});
	if (!res.ok) throw new Error(`Probe pull failed (${res.status})`);
	const blob = await res.blob();
	return new File([blob], `hf-probe-${chunk.index}.webm`, {
		type: "video/webm",
	});
}

/**
 * PROBE STAGE: author each chunk and render only its first ~PROBE_SEC seconds
 * (one author call per chunk; the full render re-renders the same comp after
 * approval, so probing costs no extra tokens). Failures are checkpointed as
 * retryable probe drafts, never silently skipped.
 */
async function probeChunks({
	chunks,
	shared,
	concurrency,
	signal,
	manifest,
	onChunkDone,
}: {
	chunks: AuthorChunk[];
	shared: SharedAuthorInputs;
	concurrency: number;
	signal?: AbortSignal;
	manifest: RunManifest;
	onChunkDone?: (done: number, total: number) => void;
}): Promise<{
	probes: ProbeDraft[];
	skipped: string[];
	tokensUsed: number;
	manifest: RunManifest;
}> {
	const probes: ProbeDraft[] = [];
	const skipped: string[] = [];
	let tokensUsed = 0;
	let done = 0;
	let m = manifest;

	await runWithConcurrency(chunks, concurrency, async (chunk) => {
		if (signal?.aborted) throw new Error("Cancelled");
		const brief = compileChunkBrief({ shared, chunk });
		if (!brief) {
			skipped.push(`segment ${chunk.label}: no speech in this segment`);
			logRun(`— skipped ${chunk.label} (no speech)`, "warn");
			done++;
			onChunkDone?.(done, chunks.length);
			return;
		}
		const chunkLen = chunk.endSec - chunk.startSec;
		try {
			logRun(
				`authoring segment ${chunk.index + 1} probe (${chunk.label}) - ${brief.transcript.trim().length} transcript chars…`,
			);
			const res = await fetch("/api/hyperframes/author", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...buildAiAuthHeaders(),
				},
				body: JSON.stringify({
					prompt: brief.prompt,
					fps: shared.canvas.fps,
					width: shared.canvas.width,
					height: shared.canvas.height,
					durationSec: chunkLen,
					probeSec: probeDurationSec(chunkLen),
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
			if (!compId) throw new Error("Author returned no comp id");
			tokensUsed += Number(res.headers.get("x-framecut-tokens")) || 0;
			const blob = await res.blob();
			probes.push({
				chunk,
				compId,
				brief: brief.prompt,
				status: "probed",
				file: new File([blob], `hf-probe-${chunk.index}.webm`, {
					type: "video/webm",
				}),
			});
			m = transitionChunk(m, chunk.index, "probed", {
				compId,
				brief: brief.prompt,
			});
			await postRunManifest(m);
			logRun(
				`✓ probe ${chunk.index + 1} ready (${probeDurationSec(chunkLen)}s of ${Math.round(chunkLen)}s)`,
			);
		} catch (e) {
			// A user cancel aborts the run; a single bad segment checkpoints as
			// failed (retryable from the drafts panel) instead of being dropped.
			if (signal?.aborted) throw e;
			const msg = e instanceof Error ? e.message : String(e);
			probes.push({ chunk, brief: brief.prompt, status: "failed", error: msg });
			m = transitionChunk(m, chunk.index, "failed", { error: msg });
			await postRunManifest(m);
			logRun(`✗ segment ${chunk.label}: ${msg} (retryable from drafts)`, "warn");
		} finally {
			done++;
			onChunkDone?.(done, chunks.length);
		}
	});

	probes.sort((a, b) => a.chunk.startSec - b.chunk.startSec);
	return { probes, skipped, tokensUsed, manifest: m };
}

/**
 * Author chunks in parallel to cut the whole-timeline run's wall-clock. Each
 * claude-code call spawns a local CLI, so 2 keeps the machine sane while roughly
 * halving a multi-segment run; hosted endpoints parallelize more cheaply → 3.
 */
function authorConcurrency(): number {
	return useAiSettingsStore.getState().authMode === "claude-code" ? 2 : 3;
}

/**
 * RUN HYPERFRAMES "authored" engine: split the video into ~90s segments, author
 * a graphic-rich composition for each, and place them across the WHOLE timeline
 * on one new overlay track. PROBE-RENDER-FIRST: the run probes each segment
 * (first ~4s) and stops for approval; the full render + placement happens in
 * renderApprovedProbeSet once the user approves the probe set in the drafts
 * review. Chunk state checkpoints to a run-manifest, so a re-run of the same
 * scope reuses rendered chunks (skipping probe + approval for them). Same
 * progress/result shape as runHyperframes so the toolbar button can call either.
 */
export async function runHyperframesWholeTimeline({
	editor,
	onProgress,
	signal,
	range,
}: {
	editor: EditorCore;
	onProgress: (p: RunProgress) => void;
	signal?: AbortSignal;
	/**
	 * When set, author graphics ONLY across this [startSec, endSec] section of the
	 * timeline (the "Run Selected Video ONLY" mode) instead of the whole timeline.
	 * The transcript still covers everything; only these chunks get graphics.
	 */
	range?: { startSec: number; endSec: number };
}): Promise<{
	placed: number;
	skipped: string[];
	tokensUsed: number;
	/** True when the run stopped at the probe gate awaiting approval. */
	probesPending?: boolean;
}> {
	const totalSec = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	if (totalSec < 1) {
		throw new Error("Add some footage to the timeline first.");
	}
	if (range && range.endSec - range.startSec < 1) {
		throw new Error("Select at least ~1s of footage to run on.");
	}
	const chunks = range
		? planAuthorChunksOver({ startSec: range.startSec, endSec: range.endSec })
		: planAuthorChunks(totalSec);

	useRunLogStore.getState().setOpen(true);
	logRun(
		`▶ RUN HYPERFRAMES — authoring graphics across ${
			range ? "the selected section" : "the whole video"
		} (${chunks.length} segment${chunks.length === 1 ? "" : "s"})`,
	);

	onProgress({ stage: "transcribing", detail: "Reading the timeline…" });
	const shared = await buildSharedInputs({ editor, signal });
	logTranscriptSummary(shared.segments);

	// No speech across the run's span (and no direction) → don't spawn one doomed
	// author per segment. Fail fast with the reason (run-log + the thrown toast).
	const spanStart = range ? range.startSec : 0;
	const spanEnd = range ? range.endSec : totalSec;
	if (
		!hasAuthorableContent(
			scopeSegments(shared.segments, spanStart, spanEnd),
			shared.direction,
		)
	) {
		throw noAuthorableContentError(editor);
	}

	// Run identity + checkpoint: same scope + same brief inputs → same runId →
	// a re-run reuses the manifest's rendered chunks instead of re-authoring.
	const runId = runIdForScope({
		startSec: spanStart,
		endSec: spanEnd,
		width: shared.canvas.width,
		height: shared.canvas.height,
		fps: shared.canvas.fps,
		lookName: shared.look.name,
		direction: shared.direction,
		selectionNames: shared.selections.map((s) => s.name),
		segments: shared.segments,
	});
	const scopeLabel = range ? "the selected section" : "the whole video";
	let manifest = await fetchRunManifest(runId);
	if (!manifest) {
		manifest = createRunManifest({
			runId,
			scope: { startSec: spanStart, endSec: spanEnd },
			canvas: shared.canvas,
			chunks,
		});
		await postRunManifest(manifest);
	}

	// RESUME: chunks a previous identical run fully rendered are reused (no
	// re-author, no re-probe; their approval lineage holds because the runId
	// only matches when every brief input is unchanged).
	const reusable = matchReusableChunks(manifest, chunks);
	// Chunks a previous run already authored (probed, or failed AFTER authoring
	// so the comp still exists) re-pull their cached probe instead.
	const resumable = manifest.chunks.filter(
		(c) =>
			!reusable.has(c.index) &&
			c.compId &&
			(c.state === "probed" || c.state === "failed"),
	);

	const probes: ProbeDraft[] = [];
	const skipped: string[] = [];
	let tokensUsed = 0;
	const fresh: AuthorChunk[] = [];
	for (const chunk of chunks) {
		if (reusable.has(chunk.index)) continue;
		const prior = resumable.find((c) => c.index === chunk.index);
		if (!prior?.compId) {
			fresh.push(chunk);
			continue;
		}
		try {
			const file = await pullCachedProbe(
				chunk,
				prior.compId,
				shared.canvas.fps,
				signal,
			);
			probes.push({
				chunk,
				compId: prior.compId,
				brief: prior.brief,
				status: "probed",
				file,
			});
			if (prior.state === "failed") {
				// Failed at the full render before; the probe is reviewable again.
				manifest = transitionChunk(manifest, chunk.index, "probed");
				await postRunManifest(manifest);
			}
		} catch (e) {
			if (signal?.aborted) throw new Error("Cancelled");
			fresh.push(chunk); // cached probe unreadable: re-author below
		}
	}

	if (fresh.length) {
		onProgress({
			stage: "rendering",
			detail: `Probing segment 1/${fresh.length}…`,
			effectIndex: 1,
			effectCount: fresh.length,
		});
		const result = await probeChunks({
			chunks: fresh,
			shared,
			concurrency: authorConcurrency(),
			signal,
			manifest,
			onChunkDone: (doneCount) =>
				onProgress({
					stage: "rendering",
					detail: `Probed ${doneCount}/${fresh.length} segments…`,
					effectIndex: Math.min(doneCount + 1, fresh.length),
					effectCount: fresh.length,
				}),
		});
		probes.push(...result.probes);
		skipped.push(...result.skipped);
		tokensUsed += result.tokensUsed;
		manifest = result.manifest;
	}
	if (tokensUsed > 0) useAiSettingsStore.getState().addTokensUsed(tokensUsed);
	if (signal?.aborted) throw new Error("Cancelled");
	probes.sort((a, b) => a.chunk.startSec - b.chunk.startSec);

	if (probes.length) {
		// THE GATE: the full render is BLOCKED until the user approves this
		// probe set in the drafts review (approval persists on the draft).
		useVariantPickerStore.getState().openProbes({
			runId,
			scopeLabel,
			approved: false,
			canvas: shared.canvas,
			probes,
			placedChunkIndexes: [],
		});
		logRun(
			`■ probes ready: review and approve to render the full pass (${probes.length} segment${probes.length === 1 ? "" : "s"})`,
		);
		onProgress({
			stage: "done",
			detail: "Probes ready: review and approve to render the full pass.",
		});
		return { placed: 0, skipped, tokensUsed, probesPending: true };
	}

	if (!reusable.size) {
		// Nothing rendered, nothing probed: every chunk was silent.
		onProgress({
			stage: "done",
			detail: "Nothing to place: every segment was silent.",
		});
		return { placed: 0, skipped, tokensUsed };
	}

	// Fast path: the whole scope is reused from a previous identical run.
	onProgress({
		stage: "rendering",
		detail: "Reusing rendered segments…",
		effectIndex: 1,
		effectCount: reusable.size,
	});
	const renders: ChunkRenderInput[] = [];
	const failedDrafts: ProbeDraft[] = [];
	for (const chunk of chunks) {
		const mc = reusable.get(chunk.index);
		if (!mc?.compId) continue;
		if (signal?.aborted) throw new Error("Cancelled");
		try {
			const file = await renderCompViaRoute(
				mc.compId,
				shared.canvas.fps,
				signal,
				chunk.index,
			);
			renders.push({
				file,
				startSec: chunk.startSec,
				compId: mc.compId,
				templateId: `authored:${mc.compId}`,
				name: `HyperFrames: ${chunk.label}`,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			manifest = transitionChunk(manifest, chunk.index, "failed", {
				error: msg,
			});
			await postRunManifest(manifest);
			failedDrafts.push({
				chunk,
				compId: mc.compId,
				status: "failed",
				error: msg,
			});
			logRun(`✗ segment ${chunk.label}: ${msg} (retryable from drafts)`, "warn");
		}
	}

	onProgress({
		stage: "placing",
		detail: "Placing graphics on a new track…",
		effectIndex: chunks.length,
		effectCount: chunks.length,
	});
	const placed = await placeHyperframesRenders({ editor, renders });
	if (placed > 0) usePreferenceStore.getState().noteGraphicsPlaced();
	logRun(
		`✓ placed ${placed} graphic segment${placed === 1 ? "" : "s"} across the video`,
	);
	if (failedDrafts.length) {
		// Surface the failed re-renders as retryable drafts (already approved).
		useVariantPickerStore.getState().openProbes({
			runId,
			scopeLabel,
			approved: true,
			canvas: shared.canvas,
			probes: failedDrafts,
			placedChunkIndexes: chunks
				.filter((c) => !failedDrafts.some((f) => f.chunk.index === c.index))
				.map((c) => c.index),
		});
	}
	onProgress({
		stage: "done",
		detail: `Placed ${placed} graphic segment${placed === 1 ? "" : "s"} across the video.`,
	});
	return {
		placed,
		skipped,
		tokensUsed,
		probesPending: failedDrafts.length > 0 || undefined,
	};
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
	const shared = await buildSharedInputs({ editor, signal });
	logTranscriptSummary(shared.segments);

	// Whole-video pass with no speech (and no direction) → every version's every
	// segment would refuse. Fail fast with the reason instead of N×M doomed authors.
	if (
		!hasAuthorableContent(
			scopeSegments(shared.segments, 0, totalSec),
			shared.direction,
		)
	) {
		throw noAuthorableContentError(editor);
	}

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

/**
 * FULL RENDER continuation: runs when the user approves a probe set in the
 * drafts review. BLOCKED until approved (canStartFullRender). Renders every
 * probed chunk's comp (plus chunks reused from an earlier identical run),
 * places them on one new track, and checkpoints every transition; a failed
 * chunk stays in the drafts as retryable instead of being dropped. Chunks
 * recorded in placedChunkIndexes are never placed twice.
 */
export async function renderApprovedProbeSet({
	editor,
	signal,
}: {
	editor: EditorCore;
	signal?: AbortSignal;
}): Promise<{ placed: number; failed: number }> {
	const store = useVariantPickerStore.getState();
	const probeSet = store.probeSet;
	if (!probeSet || !canStartFullRender(probeSet)) {
		throw new Error(
			"Approve the probes first; the full render stays blocked until then.",
		);
	}
	if (store.probeRendering) {
		throw new Error("The full render is already running.");
	}
	const set = probeSet;
	store.setProbeRendering(true);
	logRun(
		`▶ probes approved: rendering ${set.probes.length} segment${set.probes.length === 1 ? "" : "s"} (full pass)`,
	);
	try {
		let manifest = await fetchRunManifest(set.runId);
		if (manifest && !manifest.approved) {
			manifest = markApproved(manifest);
			await postRunManifest(manifest);
		}
		const alreadyPlaced = new Set(set.placedChunkIndexes);
		const probeIdx = new Set(set.probes.map((p) => p.chunk.index));
		const renders: { index: number; input: ChunkRenderInput }[] = [];
		let failed = 0;

		// Reused chunks rendered by an earlier identical run (not re-probed).
		const reused: Map<number, ManifestChunk> = manifest
			? matchReusableChunks(
					manifest,
					manifest.chunks.filter(
						(c) => !probeIdx.has(c.index) && !alreadyPlaced.has(c.index),
					),
				)
			: new Map();
		for (const mc of [...reused.values()].sort(
			(a, b) => a.startSec - b.startSec,
		)) {
			if (signal?.aborted) throw new Error("Cancelled");
			try {
				const file = await renderCompViaRoute(
					mc.compId!,
					set.canvas.fps,
					signal,
					mc.index,
				);
				renders.push({
					index: mc.index,
					input: {
						file,
						startSec: mc.startSec,
						compId: mc.compId,
						templateId: `authored:${mc.compId}`,
						name: `HyperFrames: ${fmtRange(mc.startSec, mc.endSec)}`,
						brief: mc.brief,
					},
				});
			} catch (e) {
				if (signal?.aborted) throw e;
				failed++;
				const msg = e instanceof Error ? e.message : String(e);
				logRun(`✗ segment ${fmtRange(mc.startSec, mc.endSec)}: ${msg}`, "warn");
				manifest = transitionChunk(manifest!, mc.index, "failed", {
					error: msg,
				});
				await postRunManifest(manifest);
			}
		}

		for (const p of set.probes) {
			if (signal?.aborted) throw new Error("Cancelled");
			if (p.status === "rendered" || alreadyPlaced.has(p.chunk.index)) continue;
			useVariantPickerStore
				.getState()
				.updateProbe(p.chunk.index, { status: "rendering", error: undefined });
			logRun(`rendering segment ${p.chunk.label} (full pass)…`);
			try {
				const file = await renderCompViaRoute(
					p.compId!,
					set.canvas.fps,
					signal,
					p.chunk.index,
				);
				useVariantPickerStore
					.getState()
					.updateProbe(p.chunk.index, { status: "rendered" });
				if (manifest?.chunks.some((c) => c.index === p.chunk.index)) {
					manifest = transitionChunk(manifest, p.chunk.index, "rendered");
					await postRunManifest(manifest);
				}
				renders.push({
					index: p.chunk.index,
					input: {
						file,
						startSec: p.chunk.startSec,
						compId: p.compId,
						templateId: `authored:${p.compId ?? p.chunk.index}`,
						name: `HyperFrames: ${p.chunk.label}`,
						brief: p.brief,
					},
				});
				logRun(`✓ segment ${p.chunk.label} rendered`);
			} catch (e) {
				if (signal?.aborted) throw e;
				failed++;
				const msg = e instanceof Error ? e.message : String(e);
				useVariantPickerStore
					.getState()
					.updateProbe(p.chunk.index, { status: "failed", error: msg });
				if (manifest?.chunks.some((c) => c.index === p.chunk.index)) {
					manifest = transitionChunk(manifest, p.chunk.index, "failed", {
						error: msg,
					});
					await postRunManifest(manifest);
				}
				logRun(
					`✗ segment ${p.chunk.label}: ${msg} (retryable from drafts)`,
					"warn",
				);
			}
		}

		let placed = 0;
		if (renders.length) {
			renders.sort((a, b) => a.input.startSec - b.input.startSec);
			logRun("placing rendered segments on a new track…");
			placed = await placeHyperframesRenders({
				editor,
				renders: renders.map((r) => r.input),
			});
			if (placed > 0) usePreferenceStore.getState().noteGraphicsPlaced();
			useVariantPickerStore
				.getState()
				.markProbesPlaced(renders.map((r) => r.index));
		}
		// All rendered + placed: the drafts have served their purpose. Failures
		// stay listed for retry.
		const after = useVariantPickerStore.getState();
		if (!after.probeSet?.probes.some((p) => p.status === "failed")) {
			after.discardProbes();
		}
		logRun(
			failed
				? `✓ placed ${placed} segment${placed === 1 ? "" : "s"}; ${failed} failed (retryable from drafts)`
				: `✓ placed ${placed} graphic segment${placed === 1 ? "" : "s"} across the video`,
		);
		return { placed, failed };
	} finally {
		useVariantPickerStore.getState().setProbeRendering(false);
	}
}

/**
 * RETRY one failed chunk from the drafts panel. Two shapes:
 *   - failed at the FULL RENDER (compId kept): re-render the same comp and
 *     place it; the content is unchanged, so the approval still holds.
 *   - failed at AUTHORING (no compId): re-author a probe from the saved brief;
 *     that is NEW unreviewed content, so the gate re-arms (approval resets).
 */
export async function retryProbeChunk({
	editor,
	index,
	signal,
}: {
	editor: EditorCore;
	index: number;
	signal?: AbortSignal;
}): Promise<void> {
	const store = useVariantPickerStore.getState();
	const set = store.probeSet;
	const probe = set?.probes.find((p) => p.chunk.index === index);
	if (!set || !probe) throw new Error("That probe draft is gone; run again.");
	if (probe.status !== "failed") return;

	if (probe.compId) {
		store.updateProbe(index, { status: "rendering", error: undefined });
		try {
			const file = await renderCompViaRoute(
				probe.compId,
				set.canvas.fps,
				signal,
				index,
			);
			useVariantPickerStore
				.getState()
				.updateProbe(index, { status: "rendered" });
			let manifest = await fetchRunManifest(set.runId);
			if (manifest?.chunks.some((c) => c.index === index)) {
				manifest = transitionChunk(manifest, index, "rendered");
				await postRunManifest(manifest);
			}
			const placed = await placeHyperframesRenders({
				editor,
				renders: [
					{
						file,
						startSec: probe.chunk.startSec,
						compId: probe.compId,
						templateId: `authored:${probe.compId}`,
						name: `HyperFrames: ${probe.chunk.label}`,
						brief: probe.brief,
					},
				],
			});
			if (placed > 0) usePreferenceStore.getState().noteGraphicsPlaced();
			useVariantPickerStore.getState().markProbesPlaced([index]);
			logRun(`✓ segment ${probe.chunk.label} rendered + placed on retry`);
			const after = useVariantPickerStore.getState();
			if (
				after.probeSet &&
				!after.probeSet.probes.some((p) => p.status === "failed")
			) {
				after.discardProbes();
			}
		} catch (e) {
			if (signal?.aborted) throw e;
			const msg = e instanceof Error ? e.message : String(e);
			useVariantPickerStore
				.getState()
				.updateProbe(index, { status: "failed", error: msg });
			throw new Error(msg);
		}
		return;
	}

	// Re-author path: needs the saved brief.
	if (!probe.brief) {
		throw new Error("No brief was saved for this segment; run again.");
	}
	store.updateProbe(index, { status: "rendering", error: undefined });
	const chunkLen = probe.chunk.endSec - probe.chunk.startSec;
	try {
		const res = await fetch("/api/hyperframes/author", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...buildAiAuthHeaders(),
			},
			body: JSON.stringify({
				prompt: probe.brief,
				fps: set.canvas.fps,
				width: set.canvas.width,
				height: set.canvas.height,
				durationSec: chunkLen,
				probeSec: probeDurationSec(chunkLen),
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
		if (!compId) throw new Error("Author returned no comp id");
		const tokens = Number(res.headers.get("x-framecut-tokens")) || 0;
		if (tokens > 0) useAiSettingsStore.getState().addTokensUsed(tokens);
		const blob = await res.blob();
		const file = new File([blob], `hf-probe-${index}.webm`, {
			type: "video/webm",
		});
		useVariantPickerStore
			.getState()
			.updateProbe(index, { status: "probed", compId, file, error: undefined });
		// New unreviewed content: the gate re-arms.
		useVariantPickerStore.getState().resetProbeApproval();
		let manifest = await fetchRunManifest(set.runId);
		if (manifest?.chunks.some((c) => c.index === index)) {
			manifest = transitionChunk(manifest, index, "probed", {
				compId,
				brief: probe.brief,
			});
			await postRunManifest(manifest);
		}
		logRun(
			`✓ segment ${probe.chunk.label} re-authored; approve the new probe to render it`,
		);
	} catch (e) {
		if (signal?.aborted) throw e;
		const msg = e instanceof Error ? e.message : String(e);
		useVariantPickerStore
			.getState()
			.updateProbe(index, { status: "failed", error: msg });
		throw new Error(msg);
	}
}
