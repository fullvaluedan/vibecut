/**
 * Device-local settings for FrameCut's AI generation (HyperFrames).
 *
 * Hard rule: keys live on this device only (localStorage) — never in
 * project files, never synced into recipes or exports. See docs/BRIEF.md.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateUUID } from "@/utils/id";

export type AiAuthMode = "api-key" | "claude-code" | "custom";
export type AiBackend = "local" | "heygen";

/** How many saved HyperFrames presets ("Custom Template 1–5") we allow. */
export const MAX_HF_PRESETS = 5;

/**
 * A user-saved HyperFrames preset: a named snapshot of the selections that
 * shape the authoring prompt (which templates are enabled, which registry
 * assets are pinned, the look, and the direction). Loading one re-applies
 * those selections so "the way I like HyperFrames to edit" is one click.
 */
export interface HfPreset {
	id: string;
	name: string;
	disabledTemplateIds: string[];
	promptHfAssets: string[];
	styleId: string;
	hfDirection: string;
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

	/** Saved HyperFrames presets ("Custom Template 1–5"). */
	hfPresets: HfPreset[];
	/** The preset currently loaded — cleared as soon as a selection diverges. */
	activeHfPresetId: string | null;
	/**
	 * Snapshot the current selections into a preset. With a presetId, overwrites
	 * that slot; without one, creates a new preset (capped at MAX_HF_PRESETS).
	 */
	saveHfPreset: (presetId?: string) => void;
	/** Re-apply a saved preset's selections to the live fields. */
	loadHfPreset: (presetId: string) => void;
	renameHfPreset: (presetId: string, name: string) => void;
	deleteHfPreset: (presetId: string) => void;
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
					const snapshot = {
						disabledTemplateIds: [...state.disabledTemplateIds],
						promptHfAssets: [...state.promptHfAssets],
						styleId: state.styleId,
						hfDirection: state.hfDirection,
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
		}),
		{
			name: "framecut-ai-settings",
			version: 4,
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
	return s;
}

/** Headers to attach to FrameCut AI API routes, carrying device-local auth. */
export function buildAiAuthHeaders(): Record<string, string> {
	const {
		authMode,
		anthropicApiKey,
		customBaseUrl,
		customApiKey,
		customModel,
	} = useAiSettingsStore.getState();
	const headers: Record<string, string> = {
		"x-framecut-auth-mode": authMode,
	};
	if (authMode === "api-key" && anthropicApiKey) {
		headers["x-framecut-anthropic-key"] = anthropicApiKey;
	}
	if (authMode === "custom") {
		if (customBaseUrl) headers["x-framecut-custom-base-url"] = customBaseUrl;
		if (customModel) headers["x-framecut-custom-model"] = customModel;
		if (customApiKey) headers["x-framecut-custom-key"] = customApiKey;
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
