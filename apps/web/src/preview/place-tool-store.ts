/**
 * Premiere-style place tools: arm the Text (or a Shape) tool, then click
 * anywhere on the preview to create the element at that exact spot.
 */

import { create } from "zustand";

export type PlaceTool =
	| { kind: "text" }
	| { kind: "shape"; definitionId: string }
	| { kind: "pen" }
	// Premiere's Track Select Forward (A): click the timeline to select
	// everything to the right; Shift+click limits it to the clicked track.
	| { kind: "track-select-forward" }
	// Premiere's Razor (C): click a clip on the timeline to split it at the
	// click position; Shift+click splits every track at that time. Sticky —
	// stays armed for repeated cuts until V / Escape.
	| { kind: "razor" }
	// Premiere's Rate-Stretch (R): drag a clip edge to change its playback
	// SPEED (the source window stays fixed) instead of trimming it. Sticky —
	// stays armed until V / Escape.
	| { kind: "rate-stretch" };

interface PlaceToolStore {
	tool: PlaceTool | null;
	setTool: (tool: PlaceTool | null) => void;
	toggleTextTool: () => void;
}

export const usePlaceToolStore = create<PlaceToolStore>((set) => ({
	tool: null,
	setTool: (tool) => set({ tool }),
	toggleTextTool: () =>
		set((s) => ({ tool: s.tool?.kind === "text" ? null : { kind: "text" } })),
}));
