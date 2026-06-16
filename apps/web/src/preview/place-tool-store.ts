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
	| { kind: "roll" }
	// Premiere's Slip (Y): drag a clip's INTERIOR to slide the source window under
	// it while the clip's timeline position + duration stay fixed (the footage
	// shifts; the clip doesn't move). A body-drag tool. Sticky — stays armed until
	// V / Escape.
	| { kind: "slip" }
	// Premiere's Slide (U): drag a clip's INTERIOR to move it along the timeline
	// between its two neighbours, which absorb the move (the clip's content is
	// unchanged; the neighbours' tail/head are trimmed). A body-drag tool. Sticky —
	// stays armed until V / Escape.
	| { kind: "slide" };

// The sticky timeline tools: armed tools that act on the TIMELINE (not the
// preview canvas) and stay armed for repeated use until V (selection) or Escape.
// Centralized so the Escape/cancel handler and the place-tool overlay's
// early-return share one source of truth (de-risks adding Slip/Slide).
export type StickyTimelineToolKind =
	| "track-select-forward"
	| "razor"
	| "rate-stretch"
	| "ripple"
	| "roll"
	| "slip"
	| "slide";

export const STICKY_TIMELINE_TOOLS: ReadonlySet<PlaceTool["kind"]> = new Set<
	StickyTimelineToolKind
>([
	"track-select-forward",
	"razor",
	"rate-stretch",
	"ripple",
	"roll",
	"slip",
	"slide",
]);

/**
 * Type-guard wrapper over `STICKY_TIMELINE_TOOLS.has` so callers that early-out
 * on a sticky tool also narrow `tool` to the non-sticky (canvas-place) members.
 */
export function isStickyTimelineTool(
	tool: PlaceTool,
): tool is Extract<PlaceTool, { kind: StickyTimelineToolKind }> {
	return STICKY_TIMELINE_TOOLS.has(tool.kind);
}

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
