/**
 * T18.1 crop: which element (if any) is showing on-canvas crop handles.
 * A small standalone flag, same shape as panel-maximize-store - the Crop
 * button in the Transform tab's Crop group turns it on for the selected
 * element; Escape (registered where the handles mount) or selecting a
 * different element turns it off.
 */

import { create } from "zustand";

interface CropModeStore {
	elementId: string | null;
	enter: (elementId: string) => void;
	exit: () => void;
}

export const useCropModeStore = create<CropModeStore>((set) => ({
	elementId: null,
	enter: (elementId) => set({ elementId }),
	exit: () => set({ elementId: null }),
}));
