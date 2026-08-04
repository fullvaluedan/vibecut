/**
 * Device-local settings for FrameCut's AI generation (HyperFrames).
 *
 * Hard rule: keys live on this device only (localStorage) — never in
 * project files, never synced into recipes or exports. See docs/BRIEF.md.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateUUID } from "@/utils/id";
import {
	cloneDesignSpec,
	type HfDesignProfile,
	type HfDesignSpec,
} from "@/features/ai-generate/profiles";
import {
	designSpecFromStyle,
	getStyleById,
} from "@/features/ai-generate/styles";

export type AiAuthMode =
	| "api-key"
	| "claude-code"
	| "custom"
	| "openai"
	| "xai-grok"
	| "groq-llm";
export type AiBackend = "local" | "heygen";

/**
 * The features that make LLM calls and can each pick their own provider
 * (T21.2). "default" follows the global AI connection (authMode).
 */
export type AiFeature = "director" | "assistant" | "hyperframes";
export type AiProviderSelection = "default" | AiAuthMode;

/**
 * How many saved HyperFrames presets / style profiles we allow. Raised 5 -> 8
 * with Round 20's style profiles: the six factory looks stay a separate
 * default set, but profile duplicate/edit flows burn user slots faster than
 * the old save-only flow did.
 */
export const MAX_HF_PRESETS = 8;

/**
 * A user-saved HyperFrames preset: a named snapshot of the selections that
 * shape the authoring prompt (which templates are enabled, which registry
 * assets are pinned, the look, and the direction) plus its STYLE PROFILE
 * design spec (palette, fonts, motion, density). Loading one re-applies
 * those selections so "the way I like HyperFrames to edit" is one click, and
 * the active preset's design spec is what every generation honors.
 */
export interface HfPreset {
	id: string;
	name: string;
	disabledTemplateIds: string[];
	promptHfAssets: string[];
	styleId: string;
	hfDirection: string;
	/** The profile's design spec (Round 20 style profiles). */
	design: HfDesignSpec;
}

interface AiSettingsStore {
	authMode: AiAuthMode;
	setAuthMode: (mode: AiAuthMode) => void;
	anthropicApiKey: string;
	setAnthropicApiKey: (key: string) => void;
	/**
	 * Custom OpenAI-compatible endpoint (authMode "custom") — point VibeCut at a
	 * local or self-hosted model. baseUrl should include any version prefix the
	 * server needs (e.g. ".../v1"); the key is optional for most local servers.
	 */
	customBaseUrl: string;
	setCustomBaseUrl: (url: string) => void;
	customApiKey: string;
	setCustomApiKey: (key: string) => void;
	customModel: string;
	setCustomModel: (model: string) => void;
	/**
	 * T21.2 named OpenAI-compatible chat providers. Keys are device-local like
	 * the Anthropic key; a blank model field means hf-bridge's provider default.
	 * All three are "community quality" until they pass the Director eval.
	 */
	openaiApiKey: string;
	setOpenaiApiKey: (key: string) => void;
	openaiModel: string;
	setOpenaiModel: (model: string) => void;
	xaiGrokApiKey: string;
	setXaiGrokApiKey: (key: string) => void;
	xaiGrokModel: string;
	setXaiGrokModel: (model: string) => void;
	groqLlmApiKey: string;
	setGroqLlmApiKey: (key: string) => void;
	groqLlmModel: string;
	setGroqLlmModel: (model: string) => void;
	/**
	 * Per-feature provider picks (T21.2). "default" follows the global AI
	 * connection (authMode); a specific mode pins that feature to it.
	 */
	directorProvider: AiProviderSelection;
	setDirectorProvider: (pick: AiProviderSelection) => void;
	assistantProvider: AiProviderSelection;
	setAssistantProvider: (pick: AiProviderSelection) => void;
	hyperframesProvider: AiProviderSelection;
	setHyperframesProvider: (pick: AiProviderSelection) => void;
	/** HeyGen API key — unlocks music & SFX search in the Sounds panel. */
	heygenApiKey: string;
	setHeygenApiKey: (key: string) => void;
	/** SerpAPI key — unlocks "find b-roll" in the assistant prompt box. */
	serpApiKey: string;
	setSerpApiKey: (key: string) => void;
	/** Transcribe the timeline in the background so AI runs start instantly. */
	backgroundTranscriptionEnabled: boolean;
	setBackgroundTranscriptionEnabled: (enabled: boolean) => void;
	/**
	 * Where transcription runs. "in-browser" (default) uses the local Whisper
	 * worker — slow on long sources and segment-level only. "cloud" uploads the
	 * timeline audio to /api/transcribe (currently Groq whisper-large-v3-turbo):
	 * fast, accurate, and always word-level (re-arms the Director's word
	 * detectors). Needs a Groq key. Opt-in, so a user without a key is unaffected.
	 */
	transcriptionBackend: "in-browser" | "cloud";
	setTranscriptionBackend: (backend: "in-browser" | "cloud") => void;
	/** Groq API key (BYO) for cloud transcription. Device-local, never synced. */
	groqApiKey: string;
	setGroqApiKey: (key: string) => void;
	/**
	 * Send sampled footage frames to the Director so its cuts can SEE the video
	 * (catch off-screen / frozen / dead-air visuals). Opt-in — frames cost tokens
	 * and only `api-key` / vision-capable `custom` backends accept them.
	 */
	directorVisionEnabled: boolean;
	setDirectorVisionEnabled: (enabled: boolean) => void;
	/**
	 * Opt-in (default off): VAD-gated transcription on the analysis path — run the
	 * Silero VAD first and transcribe ONLY the speech intervals (concatenated),
	 * remapping word/segment times back to the timeline. Faster + no silence
	 * hallucination on long sources. Falls back to full-audio transcription if VAD
	 * is off or fails. Analysis path only; captions are unaffected.
	 */
	directorVadGatedTranscriptionEnabled: boolean;
	setDirectorVadGatedTranscriptionEnabled: (enabled: boolean) => void;
	/**
	 * Low-power mode for constrained machines: pauses background transcription
	 * and lowers the preview render scale. Heavy renders are already serialized.
	 */
	lowPowerMode: boolean;
	setLowPowerMode: (enabled: boolean) => void;
	/**
	 * RUN HYPERFRAMES effect engine: "native" places instant, fully editable
	 * motion-template elements; "cinematic" renders each effect with the
	 * HyperFrames CLI (slower, burned in at export).
	 */
	hfEngine: "native" | "cinematic" | "authored";
	setHfEngine: (engine: "native" | "cinematic" | "authored") => void;
	backend: AiBackend;
	setBackend: (backend: AiBackend) => void;
	/** Active VibeStyle id — colors all new AI generations. */
	styleId: string;
	setStyleId: (styleId: string) => void;
	/**
	 * Template ids UNCHECKED in the HyperFrames panel. Stored as a deny-list
	 * so templates added in future updates start enabled.
	 */
	disabledTemplateIds: string[];
	toggleTemplate: (id: string) => void;
	/**
	 * Registry asset names the user CHECKED to feed the RUN HYPERFRAMES authoring
	 * brief (an allow-list; default off). Checking an asset means "use this in the
	 * Authored run" (e.g. author something using swiss-grid / us-map).
	 */
	promptHfAssets: string[];
	togglePromptHfAsset: (name: string) => void;
	/** Bulk check/uncheck for a whole browser section. */
	setTemplatesEnabled: (ids: string[], enabled: boolean) => void;
	setPromptHfAssetsEnabled: (names: string[], enabled: boolean) => void;
	/** HyperFrames browser layout. */
	hfBrowserView: "grid" | "list";
	setHfBrowserView: (view: "grid" | "list") => void;
	/** Free-form planner instructions from the HyperFrames prompt window. */
	hfDirection: string;
	setHfDirection: (direction: string) => void;
	/** Lifetime Claude token usage from HyperFrames runs on this device. */
	tokensUsedTotal: number;
	addTokensUsed: (tokens: number) => void;

	/** Saved HyperFrames presets ("Custom Template N") / style profiles. */
	hfPresets: HfPreset[];
	/** The preset currently loaded — cleared as soon as a selection diverges. */
	activeHfPresetId: string | null;
	/**
	 * Snapshot the current selections into a preset. With a presetId, overwrites
	 * that slot; without one, creates a new preset (capped at MAX_HF_PRESETS).
	 * The design spec comes from the active preset when one is loaded, else
	 * from the current factory look.
	 */
	saveHfPreset: (presetId?: string) => void;
	/** Re-apply a saved preset's selections to the live fields. */
	loadHfPreset: (presetId: string) => void;
	renameHfPreset: (presetId: string, name: string) => void;
	deleteHfPreset: (presetId: string) => void;
	/** Copy a preset (design included) into a new slot, "name copy". */
	duplicateHfPreset: (presetId: string) => void;
	/**
	 * Edit a preset's design spec in place (the profile editor). Does not
	 * clear the active id, so edits to the active profile apply immediately.
	 */
	updateHfPresetDesign: (presetId: string, design: HfDesignSpec) => void;
}

export const useAiSettingsStore = create<AiSettingsStore>()(
	persist(
		(set) => ({
			authMode: "claude-code",
			setAuthMode: (authMode) => set({ authMode }),

			anthropicApiKey: "",
			setAnthropicApiKey: (anthropicApiKey) => set({ anthropicApiKey }),

			customBaseUrl: "",
			setCustomBaseUrl: (customBaseUrl) => set({ customBaseUrl }),
			customApiKey: "",
			setCustomApiKey: (customApiKey) => set({ customApiKey }),
			customModel: "",
			setCustomModel: (customModel) => set({ customModel }),

			openaiApiKey: "",
			setOpenaiApiKey: (openaiApiKey) => set({ openaiApiKey }),
			openaiModel: "",
			setOpenaiModel: (openaiModel) => set({ openaiModel }),
			xaiGrokApiKey: "",
			setXaiGrokApiKey: (xaiGrokApiKey) => set({ xaiGrokApiKey }),
			xaiGrokModel: "",
			setXaiGrokModel: (xaiGrokModel) => set({ xaiGrokModel }),
			groqLlmApiKey: "",
			setGroqLlmApiKey: (groqLlmApiKey) => set({ groqLlmApiKey }),
			groqLlmModel: "",
			setGroqLlmModel: (groqLlmModel) => set({ groqLlmModel }),

			directorProvider: "default",
			setDirectorProvider: (directorProvider) => set({ directorProvider }),
			assistantProvider: "default",
			setAssistantProvider: (assistantProvider) => set({ assistantProvider }),
			hyperframesProvider: "default",
			setHyperframesProvider: (hyperframesProvider) =>
				set({ hyperframesProvider }),

			heygenApiKey: "",
			setHeygenApiKey: (heygenApiKey) => set({ heygenApiKey }),

			serpApiKey: "",
			setSerpApiKey: (serpApiKey) => set({ serpApiKey }),

			backgroundTranscriptionEnabled: true,
			setBackgroundTranscriptionEnabled: (backgroundTranscriptionEnabled) =>
				set({ backgroundTranscriptionEnabled }),

			transcriptionBackend: "in-browser",
			setTranscriptionBackend: (transcriptionBackend) =>
				set({ transcriptionBackend }),
			groqApiKey: "",
			setGroqApiKey: (groqApiKey) => set({ groqApiKey }),

			directorVisionEnabled: false,
			setDirectorVisionEnabled: (directorVisionEnabled) =>
				set({ directorVisionEnabled }),

			directorVadGatedTranscriptionEnabled: false,
			setDirectorVadGatedTranscriptionEnabled: (
				directorVadGatedTranscriptionEnabled,
			) => set({ directorVadGatedTranscriptionEnabled }),

			lowPowerMode: false,
			setLowPowerMode: (lowPowerMode) => set({ lowPowerMode }),

			hfEngine: "authored",
			setHfEngine: (hfEngine) => set({ hfEngine }),

			backend: "local",
			setBackend: (backend) => set({ backend }),

			styleId: "ember",
			setStyleId: (styleId) => set({ styleId, activeHfPresetId: null }),

			disabledTemplateIds: [],
			toggleTemplate: (id) =>
				set((state) => ({
					disabledTemplateIds: state.disabledTemplateIds.includes(id)
						? state.disabledTemplateIds.filter((t) => t !== id)
						: [...state.disabledTemplateIds, id],
					activeHfPresetId: null,
				})),

			promptHfAssets: [],
			togglePromptHfAsset: (name) =>
				set((state) => ({
					promptHfAssets: state.promptHfAssets.includes(name)
						? state.promptHfAssets.filter((n) => n !== name)
						: [...state.promptHfAssets, name],
					activeHfPresetId: null,
				})),
			setTemplatesEnabled: (ids, enabled) =>
				set((state) => ({
					disabledTemplateIds: enabled
						? state.disabledTemplateIds.filter((id) => !ids.includes(id))
						: [...new Set([...state.disabledTemplateIds, ...ids])],
					activeHfPresetId: null,
				})),
			setPromptHfAssetsEnabled: (names, enabled) =>
				set((state) => ({
					promptHfAssets: enabled
						? [...new Set([...state.promptHfAssets, ...names])]
						: state.promptHfAssets.filter((n) => !names.includes(n)),
					activeHfPresetId: null,
				})),

			hfBrowserView: "grid",
			setHfBrowserView: (hfBrowserView) => set({ hfBrowserView }),

			hfDirection: "",
			setHfDirection: (hfDirection) =>
				set({ hfDirection, activeHfPresetId: null }),

			tokensUsedTotal: 0,
			addTokensUsed: (tokens) =>
				set((state) => ({
					tokensUsedTotal: state.tokensUsedTotal + Math.max(0, tokens),
				})),

			hfPresets: [],
			activeHfPresetId: null,

			saveHfPreset: (presetId) =>
				set((state) => {
					// The design spec snapshots from the ACTIVE preset when one is
					// loaded (its profile is the live design), else from the current
					// factory look - the look the next generation would use anyway.
					const activePreset = state.hfPresets.find(
						(p) => p.id === state.activeHfPresetId,
					);
					const snapshot = {
						disabledTemplateIds: [...state.disabledTemplateIds],
						promptHfAssets: [...state.promptHfAssets],
						styleId: state.styleId,
						hfDirection: state.hfDirection,
						design: activePreset
							? cloneDesignSpec(activePreset.design)
							: designSpecFromStyle(getStyleById(state.styleId)),
					};
					if (presetId) {
						// Overwrite an existing slot with the current selection.
						return {
							hfPresets: state.hfPresets.map((p) =>
								p.id === presetId ? { ...p, ...snapshot } : p,
							),
							activeHfPresetId: presetId,
						};
					}
					if (state.hfPresets.length >= MAX_HF_PRESETS) return state;
					// Default to the lowest unused "Custom Template N" label.
					const used = new Set(state.hfPresets.map((p) => p.name));
					let n = 1;
					while (n <= MAX_HF_PRESETS && used.has(`Custom Template ${n}`)) n++;
					const id = generateUUID();
					return {
						hfPresets: [
							...state.hfPresets,
							{ id, name: `Custom Template ${n}`, ...snapshot },
						],
						activeHfPresetId: id,
					};
				}),

			loadHfPreset: (presetId) =>
				set((state) => {
					const preset = state.hfPresets.find((p) => p.id === presetId);
					if (!preset) return state;
					// Apply atomically (NOT via the individual setters, which would
					// immediately clear activeHfPresetId as a "divergence").
					return {
						disabledTemplateIds: [...preset.disabledTemplateIds],
						promptHfAssets: [...preset.promptHfAssets],
						styleId: preset.styleId,
						hfDirection: preset.hfDirection,
						activeHfPresetId: preset.id,
					};
				}),

			renameHfPreset: (presetId, name) =>
				set((state) => ({
					hfPresets: state.hfPresets.map((p) =>
						p.id === presetId ? { ...p, name: name.trim() || p.name } : p,
					),
				})),

			deleteHfPreset: (presetId) =>
				set((state) => ({
					hfPresets: state.hfPresets.filter((p) => p.id !== presetId),
					activeHfPresetId:
						state.activeHfPresetId === presetId ? null : state.activeHfPresetId,
				})),

			duplicateHfPreset: (presetId) =>
				set((state) => {
					const source = state.hfPresets.find((p) => p.id === presetId);
					if (!source || state.hfPresets.length >= MAX_HF_PRESETS) return state;
					const used = new Set(state.hfPresets.map((p) => p.name));
					let name = `${source.name} copy`;
					let n = 2;
					while (used.has(name)) name = `${source.name} copy ${n++}`;
					const id = generateUUID();
					return {
						hfPresets: [
							...state.hfPresets,
							{
								...source,
								id,
								name,
								disabledTemplateIds: [...source.disabledTemplateIds],
								promptHfAssets: [...source.promptHfAssets],
								design: cloneDesignSpec(source.design),
							},
						],
						// Duplicating the ACTIVE preset keeps the copy active (its
						// selections still match the live fields); otherwise the live
						// state is untouched.
						activeHfPresetId:
							state.activeHfPresetId === presetId ? id : state.activeHfPresetId,
					};
				}),

			updateHfPresetDesign: (presetId, design) =>
				set((state) => ({
					hfPresets: state.hfPresets.map((p) =>
						p.id === presetId ? { ...p, design: cloneDesignSpec(design) } : p,
					),
				})),
		}),
		{
			name: "framecut-ai-settings",
			version: 6,
			migrate: (persisted, version) =>
				migrateAiSettings(persisted, version) as unknown as AiSettingsStore,
		},
	),
);

/**
 * Persisted-state migration for framecut-ai-settings. Pure + exported for tests.
 * v1: the default effect engine moved to Authored; flip a stored legacy "native".
 * v2: VAD dead-air removal became default-ON for the Director path (U2). Every
 * pre-v2 install has the old `false` default frozen in storage (any set()
 * persisted the whole state), which would silently override the new default
 * forever. Reset it once; turning it off after this persists under v2.
 * v3: directorVadDeadAirEnabled deleted outright (menu IA round, Dan's decision):
 * the toggle, its Settings section, and the Silero pass on the default Director
 * path are gone, so a persisted value is stale data, not a preference. Drop the
 * key rather than freezing it at some default (the delete-not-default precedent).
 * v4: directorRetake + directorStructural deleted outright (Addendum 9
 * consolidation verdict: match gains on all four eval fixtures with AUTO harm
 * unchanged, so both recall passes go default-ON with their Settings toggles
 * removed, following the v3 VAD delete-not-default precedent). A persisted
 * true/false for either key is stale data, not a preference; drop both.
 * v5: presets gained a design spec (Round 20 style profiles). Seed each saved
 * preset's spec from its own styleId so a migrated preset generates the exact
 * same look it always did - additive and lossless; presets that already carry
 * a design are left alone.
 * v6: T21.2 provider abstraction. New fields only: the three named
 * OpenAI-compatible providers' key/model fields and the per-feature provider
 * picks. Backfill the picks to "default" (follow the global connection) when
 * absent so a migrated install behaves exactly as before - additive and
 * lossless, like v5. The pre-v6 authMode values and key fields are untouched
 * (the eval disk cache and this store's persisted shape depend on them).
 */
export function migrateAiSettings(
	persisted: unknown,
	version: number,
): Record<string, unknown> {
	const s = (persisted ?? {}) as Record<string, unknown>;
	if (version < 1 && s.hfEngine === "native") {
		s.hfEngine = "authored";
	}
	if (version < 2) {
		s.directorVadDeadAirEnabled = true;
	}
	if (version < 3) {
		delete s.directorVadDeadAirEnabled;
	}
	if (version < 4) {
		delete s.directorRetake;
		delete s.directorStructural;
	}
	if (version < 5 && Array.isArray(s.hfPresets)) {
		s.hfPresets = (s.hfPresets as Record<string, unknown>[]).map((p) => {
			if (!p || typeof p !== "object" || p.design) return p;
			const styleId = typeof p.styleId === "string" ? p.styleId : "";
			return { ...p, design: designSpecFromStyle(getStyleById(styleId)) };
		});
	}
	if (version < 6 && Object.keys(s).length > 0) {
		s.directorProvider ??= "default";
		s.assistantProvider ??= "default";
		s.hyperframesProvider ??= "default";
	}
	return s;
}

/**
 * The design spec a generation should honor right now: the ACTIVE preset's
 * spec when a profile is loaded, else the current factory look expressed as a
 * spec (which is exactly the pre-profiles behavior). Pure + exported for
 * tests; the T20.3 media-pack manifest serializes the same spec shape.
 */
export interface ResolvedDesignSpec extends HfDesignProfile {
	/** true when a user-saved profile is active (vs the factory look). */
	custom: boolean;
}

export function resolveDesignSpec(state: {
	hfPresets: HfPreset[];
	activeHfPresetId: string | null;
	styleId: string;
}): ResolvedDesignSpec {
	const active = state.hfPresets.find((p) => p.id === state.activeHfPresetId);
	if (active) {
		return {
			name: active.name,
			// Tolerate an unmigrated preset (no design yet): fall back to the
			// spec of its own look rather than crashing a generation.
			spec: active.design ?? designSpecFromStyle(getStyleById(active.styleId)),
			custom: true,
		};
	}
	const style = getStyleById(state.styleId);
	return { name: style.name, spec: designSpecFromStyle(style), custom: false };
}

/**
 * Resolve the effective auth mode for a feature: the per-feature pick when one
 * is pinned, else the global AI connection (T21.2 resolution order: per-feature
 * pick -> global default; the server env fallback is applied route-side).
 */
export function resolveEffectiveAuthMode(
	state: {
		authMode: AiAuthMode;
		directorProvider: AiProviderSelection;
		assistantProvider: AiProviderSelection;
		hyperframesProvider: AiProviderSelection;
	},
	feature?: AiFeature,
): AiAuthMode {
	const pick = feature
		? state[
				feature === "director"
					? "directorProvider"
					: feature === "assistant"
						? "assistantProvider"
						: "hyperframesProvider"
			]
		: "default";
	return pick && pick !== "default" ? pick : state.authMode;
}

/**
 * Headers to attach to FrameCut AI API routes, carrying device-local auth.
 * `feature` (T21.2) applies that feature's provider pick before emitting;
 * the header names for the pre-existing modes are byte-stable (the eval disk
 * cache and resolveAiAuth depend on them).
 */
export function buildAiAuthHeaders(feature?: AiFeature): Record<string, string> {
	const state = useAiSettingsStore.getState();
	const authMode = resolveEffectiveAuthMode(state, feature);
	const headers: Record<string, string> = {
		"x-framecut-auth-mode": authMode,
	};
	if (authMode === "api-key" && state.anthropicApiKey) {
		headers["x-framecut-anthropic-key"] = state.anthropicApiKey;
	}
	if (authMode === "custom") {
		if (state.customBaseUrl)
			headers["x-framecut-custom-base-url"] = state.customBaseUrl;
		if (state.customModel) headers["x-framecut-custom-model"] = state.customModel;
		if (state.customApiKey) headers["x-framecut-custom-key"] = state.customApiKey;
	}
	if (authMode === "openai") {
		if (state.openaiApiKey) headers["x-framecut-openai-key"] = state.openaiApiKey;
		if (state.openaiModel)
			headers["x-framecut-openai-model"] = state.openaiModel;
	}
	if (authMode === "xai-grok") {
		if (state.xaiGrokApiKey)
			headers["x-framecut-xai-grok-key"] = state.xaiGrokApiKey;
		if (state.xaiGrokModel)
			headers["x-framecut-xai-grok-model"] = state.xaiGrokModel;
	}
	if (authMode === "groq-llm") {
		if (state.groqLlmApiKey)
			headers["x-framecut-groq-llm-key"] = state.groqLlmApiKey;
		if (state.groqLlmModel)
			headers["x-framecut-groq-llm-model"] = state.groqLlmModel;
	}
	return headers;
}

/** Headers carrying the device-local cloud-transcription provider + key. */
export function buildTranscribeHeaders(): Record<string, string> {
	const { groqApiKey } = useAiSettingsStore.getState();
	const headers: Record<string, string> = {
		"x-framecut-transcribe-provider": "groq",
	};
	if (groqApiKey) headers["x-framecut-transcribe-key"] = groqApiKey;
	return headers;
}

/**
 * Whether GET /api/transcribe reports a server-configured Groq key (Round 21
 * groundwork: a deployment-wide GROQ_API_KEY, so cloud transcription works
 * without every user pasting their own key). Probed once and cached for the
 * session, module-level, no re-probe on window focus. A stale cached "true"
 * is harmless: the existing cloud-failure fallback (T16.3 G6) still catches a
 * rejected/expired server key and drops to local transcription.
 */
let serverGroqKeyProbe: Promise<boolean> | null = null;

function isServerGroqKeyPayload(
	value: unknown,
): value is { groqServerKey: boolean } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>).groqServerKey === "boolean"
	);
}

/** Probes (and caches) whether the server has a Groq key configured. */
export function probeServerGroqKey(): Promise<boolean> {
	if (!serverGroqKeyProbe) {
		serverGroqKeyProbe = fetch("/api/transcribe")
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => (isServerGroqKeyPayload(data) ? data.groqServerKey : false))
			.catch(() => false);
	}
	return serverGroqKeyProbe;
}

/** Test-only: clears the cached probe so a fresh scenario can be set up. */
export function resetServerGroqKeyProbeForTests(): void {
	serverGroqKeyProbe = null;
}

/**
 * Whether a cloud-transcription attempt should be made: the user picked
 * "cloud" AND either they have a device-local Groq key OR the server reports
 * one configured. The device-local key is checked first so a user who
 * already has a key never pays for the probe request.
 */
export async function shouldAttemptCloudTranscription(): Promise<boolean> {
	const { transcriptionBackend, groqApiKey } = useAiSettingsStore.getState();
	if (transcriptionBackend !== "cloud") return false;
	if (groqApiKey) return true;
	return probeServerGroqKey();
}
