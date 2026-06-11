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
}

export const useAiSettingsStore = create<AiSettingsStore>()(
	persist(
		(set) => ({
			authMode: "claude-code",
			setAuthMode: (authMode) => set({ authMode }),

			anthropicApiKey: "",
			setAnthropicApiKey: (anthropicApiKey) => set({ anthropicApiKey }),

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
