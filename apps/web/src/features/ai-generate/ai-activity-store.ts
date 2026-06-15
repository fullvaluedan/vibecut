import { create } from "zustand";

/**
 * A tiny global "an AI run is happening right now" flag. Heavy AI work
 * (RUN HYPERFRAMES, AI CUT) sets `busy` for its duration so the in-browser
 * background transcriber pauses instead of running Whisper at the same time —
 * the two competing for the machine is a big part of what made runs feel heavy.
 */
interface AiActivityStore {
	busy: boolean;
	setBusy: (busy: boolean) => void;
}

export const useAiActivityStore = create<AiActivityStore>((set) => ({
	busy: false,
	setBusy: (busy) => set({ busy }),
}));
