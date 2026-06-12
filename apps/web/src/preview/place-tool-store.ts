/**
 * Premiere-style place tools: arm the Text (or a Shape) tool, then click
 * anywhere on the preview to create the element at that exact spot.
 */

import { create } from "zustand";

export type PlaceTool =
	| { kind: "text" }
	| { kind: "shape"; definitionId: string }
	| { kind: "pen" };

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
