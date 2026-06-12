/**
 * Premiere's ` behavior, editor-wide: whichever panel the cursor is over
 * fills the screen when ` is pressed (or via double-click / the panel's
 * maximize button); pressing again or Esc restores the layout.
 */

import { create } from "zustand";

export type EditorPanelId = "assets" | "preview" | "properties" | "timeline";

interface PanelMaximizeStore {
	hovered: EditorPanelId | null;
	maximized: EditorPanelId | null;
	setHovered: (panel: EditorPanelId | null) => void;
	setMaximized: (panel: EditorPanelId | null) => void;
	toggleMaximized: (panel?: EditorPanelId) => void;
}

export const usePanelMaximizeStore = create<PanelMaximizeStore>((set) => ({
	hovered: null,
	maximized: null,
	setHovered: (hovered) => set({ hovered }),
	setMaximized: (maximized) => set({ maximized }),
	toggleMaximized: (panel) =>
		set((state) => ({
			maximized: state.maximized
				? null
				: (panel ?? state.hovered ?? "assets"),
		})),
}));
