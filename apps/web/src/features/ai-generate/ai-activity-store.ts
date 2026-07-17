import { create } from "zustand";

/**
 * A tiny global "an AI run is happening right now" flag, PLUS the shared run-
 * progress fields (R1/KTD1). `label`/`stage`/`cancel` let the persistent Director
 * dock's Running view and the AI CUT toolbar button read the SAME in-flight run
 * instead of each keeping its own local `useState`, so switching between the two
 * surfaces never loses the live stage text or the ability to stop the run.
 *
 * `busy` keeps its original, narrower meaning UNCHANGED: heavy AI work (RUN
 * HYPERFRAMES, AI CUT) sets it for the duration so the in-browser background
 * transcriber pauses instead of running Whisper at the same time. It is set
 * alongside `label`/`stage`/`cancel` by every AI CUT action, but a caller may still
 * flip it independently (e.g. RUN HYPERFRAMES, which has no label/stage of its own).
 */
interface AiActivityStore {
	busy: boolean;
	setBusy: (busy: boolean) => void;
	/** The running action's display name (e.g. "AI Director"), or null when idle. */
	label: string | null;
	setLabel: (label: string | null) => void;
	/** The current progress line (e.g. "Transcribing..."), or null when idle. */
	stage: string | null;
	setStage: (stage: string | null) => void;
	/** Aborts the in-flight run, or null when nothing is running. */
	cancel: (() => void) | null;
	setCancel: (cancel: (() => void) | null) => void;
}

export const useAiActivityStore = create<AiActivityStore>((set) => ({
	busy: false,
	setBusy: (busy) => set({ busy }),
	label: null,
	setLabel: (label) => set({ label }),
	stage: null,
	setStage: (stage) => set({ stage }),
	cancel: null,
	setCancel: (cancel) => set({ cancel }),
}));
