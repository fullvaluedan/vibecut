import { create } from "zustand";

export type EnhanceJobOutcome = "done" | "failed" | "cancelled";

/**
 * App-global state for the ClearVoice enhancement job so the Audio panel can
 * show an inline, NON-BLOCKING progress bar and Cancel button while the user
 * keeps editing (started from the Audio tab OR the toolbar - the panel always
 * reflects the same job).
 */
interface EnhanceJobStore {
	active: boolean;
	label: string;
	doneChunks: number;
	totalChunks: number;
	outcome: EnhanceJobOutcome | null;
	message?: string;
	abort: (() => void) | null;
	begin: (label: string) => AbortController;
	progress: ({
		doneChunks,
		totalChunks,
	}: {
		doneChunks: number;
		totalChunks: number;
	}) => void;
	finish: ({
		outcome,
		message,
	}: {
		outcome: EnhanceJobOutcome;
		message?: string;
	}) => void;
}

export const useEnhanceJobStore = create<EnhanceJobStore>((set) => ({
	active: false,
	label: "",
	doneChunks: 0,
	totalChunks: 0,
	outcome: null,
	abort: null,
	begin: (label) => {
		const controller = new AbortController();
		set({
			active: true,
			label,
			doneChunks: 0,
			totalChunks: 0,
			outcome: null,
			message: undefined,
			abort: () => controller.abort(),
		});
		return controller;
	},
	progress: ({ doneChunks, totalChunks }) => set({ doneChunks, totalChunks }),
	finish: ({ outcome, message }) =>
		set({ active: false, outcome, message, abort: null }),
}));
