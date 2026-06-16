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
	| { kind: "rate-stretch" }
	// Premiere's Ripple Edit (B): drag a clip edge to trim it AND ripple every
	// downstream clip by the same amount (no gap/overlap opens). Sticky — stays
	// armed until V / Escape.
	| { kind: "ripple" }
	// Premiere's Roll Edit: drag the cut between two adjacent clips to move the
	// edit point (one grows, the other shrinks; no ripple). Sticky — stays armed
	// until V / Escape. (No default key — Premiere's N is taken by snapping.)
	| { kind: "roll" };

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
