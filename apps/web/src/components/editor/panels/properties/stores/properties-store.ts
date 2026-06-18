import { create } from "zustand";

interface PropertiesState {
	activeTabPerType: Record<string, string>;
	setActiveTab: (args: { elementType: string; tabId: string }) => void;
}

export const usePropertiesStore = create<PropertiesState>()((set) => ({
	activeTabPerType: {},
	setActiveTab: ({ elementType, tabId }) =>
		set((state) => ({
			activeTabPerType: { ...state.activeTabPerType, [elementType]: tabId },
		})),
}));
