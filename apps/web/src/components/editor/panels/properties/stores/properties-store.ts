import { create } from "zustand";

interface PropertiesState {
	activeTabPerType: Record<string, string>;
	setActiveTab: (args: { elementType: string; tabId: string }) => void;
	isTransformScaleLocked: boolean;
	setTransformScaleLocked: (args: { locked: boolean }) => void;
}

export const usePropertiesStore = create<PropertiesState>()((set) => ({
	activeTabPerType: {},
	setActiveTab: ({ elementType, tabId }) =>
		set((state) => ({
			activeTabPerType: { ...state.activeTabPerType, [elementType]: tabId },
		})),
	// Premiere's Motion effect defaults Uniform Scale ON — height and width
	// scale together until the user unchecks it.
	isTransformScaleLocked: true,
	setTransformScaleLocked: ({ locked }) =>
		set({ isTransformScaleLocked: locked }),
}));
