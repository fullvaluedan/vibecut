/**
 * Device-local settings for FrameCut's AI generation (HyperFrames).
 *
 * Hard rule: keys live on this device only (localStorage) — never in
 * project files, never synced into recipes or exports. See docs/BRIEF.md.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AiAuthMode = "api-key" | "claude-code";
export type AiBackend = "local" | "heygen";

interface AiSettingsStore {
	authMode: AiAuthMode;
	setAuthMode: (mode: AiAuthMode) => void;
	anthropicApiKey: string;
	setAnthropicApiKey: (key: string) => void;
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
	 * Registry asset names UNCHECKED in the Effects-tab HyperFrames browser
	 * (deny-list, like disabledTemplateIds).
	 */
	disabledHfAssets: string[];
	toggleHfAsset: (name: string) => void;
	/**
	 * Registry asset names the user explicitly PICKED to feed the RUN
	 * HYPERFRAMES authoring brief (an ALLOW-list — distinct from the disabled
	 * deny-list). Lets a user say "author something using swiss-grid / us-map".
	 */
	promptHfAssets: string[];
	togglePromptHfAsset: (name: string) => void;
	/** Bulk check/uncheck for a whole browser section. */
	setTemplatesEnabled: (ids: string[], enabled: boolean) => void;
	setHfAssetsEnabled: (names: string[], enabled: boolean) => void;
	/** HyperFrames browser layout. */
	hfBrowserView: "grid" | "list";
	setHfBrowserView: (view: "grid" | "list") => void;
	/** Free-form planner instructions from the HyperFrames prompt window. */
	hfDirection: string;
	setHfDirection: (direction: string) => void;
	/** Lifetime Claude token usage from HyperFrames runs on this device. */
	tokensUsedTotal: number;
	addTokensUsed: (tokens: number) => void;
}

export const useAiSettingsStore = create<AiSettingsStore>()(
	persist(
		(set) => ({
			authMode: "claude-code",
			setAuthMode: (authMode) => set({ authMode }),

			anthropicApiKey: "",
			setAnthropicApiKey: (anthropicApiKey) => set({ anthropicApiKey }),

			heygenApiKey: "",
			setHeygenApiKey: (heygenApiKey) => set({ heygenApiKey }),

			serpApiKey: "",
			setSerpApiKey: (serpApiKey) => set({ serpApiKey }),

			backgroundTranscriptionEnabled: true,
			setBackgroundTranscriptionEnabled: (backgroundTranscriptionEnabled) =>
				set({ backgroundTranscriptionEnabled }),

			hfEngine: "native",
			setHfEngine: (hfEngine) => set({ hfEngine }),

			backend: "local",
			setBackend: (backend) => set({ backend }),

			styleId: "ember",
			setStyleId: (styleId) => set({ styleId }),

			disabledTemplateIds: [],
			toggleTemplate: (id) =>
				set((state) => ({
					disabledTemplateIds: state.disabledTemplateIds.includes(id)
						? state.disabledTemplateIds.filter((t) => t !== id)
						: [...state.disabledTemplateIds, id],
				})),

			disabledHfAssets: [],
			toggleHfAsset: (name) =>
				set((state) => ({
					disabledHfAssets: state.disabledHfAssets.includes(name)
						? state.disabledHfAssets.filter((n) => n !== name)
						: [...state.disabledHfAssets, name],
				})),

			promptHfAssets: [],
			togglePromptHfAsset: (name) =>
				set((state) => ({
					promptHfAssets: state.promptHfAssets.includes(name)
						? state.promptHfAssets.filter((n) => n !== name)
						: [...state.promptHfAssets, name],
				})),
			setTemplatesEnabled: (ids, enabled) =>
				set((state) => ({
					disabledTemplateIds: enabled
						? state.disabledTemplateIds.filter((id) => !ids.includes(id))
						: [...new Set([...state.disabledTemplateIds, ...ids])],
				})),
			setHfAssetsEnabled: (names, enabled) =>
				set((state) => ({
					disabledHfAssets: enabled
						? state.disabledHfAssets.filter((n) => !names.includes(n))
						: [...new Set([...state.disabledHfAssets, ...names])],
				})),

			hfBrowserView: "grid",
			setHfBrowserView: (hfBrowserView) => set({ hfBrowserView }),

			hfDirection: "",
			setHfDirection: (hfDirection) => set({ hfDirection }),

			tokensUsedTotal: 0,
			addTokensUsed: (tokens) =>
				set((state) => ({
					tokensUsedTotal: state.tokensUsedTotal + Math.max(0, tokens),
				})),
		}),
		{
			name: "framecut-ai-settings",
		},
	),
);

/** Headers to attach to FrameCut AI API routes, carrying device-local auth. */
export function buildAiAuthHeaders(): Record<string, string> {
	const { authMode, anthropicApiKey } = useAiSettingsStore.getState();
	const headers: Record<string, string> = {
		"x-framecut-auth-mode": authMode,
	};
	if (authMode === "api-key" && anthropicApiKey) {
		headers["x-framecut-anthropic-key"] = anthropicApiKey;
	}
	return headers;
}
