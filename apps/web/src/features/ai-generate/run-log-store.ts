/**
 * Append-only run log — the "terminal" for HyperFrames / transcription runs.
 *
 * RUN HYPERFRAMES can sit on a slow stage (first-run model download, audio
 * decode) where the single progress bar barely moves. This ring-buffered log
 * gives the user continuous, timestamped motion so they can see it IS working,
 * and a record of what happened if it fails.
 */

import { create } from "zustand";

export interface RunLogLine {
	id: number;
	/** epoch ms */
	t: number;
	text: string;
	level: "info" | "warn" | "error";
}

interface RunLogStore {
	lines: RunLogLine[];
	open: boolean;
	push: (text: string, level?: RunLogLine["level"]) => void;
	clear: () => void;
	setOpen: (open: boolean) => void;
}

const MAX_LINES = 200;
let seq = 0;

export const useRunLogStore = create<RunLogStore>((set) => ({
	lines: [],
	open: false,
	push: (text, level = "info") =>
		set((s) => {
			// Collapse identical consecutive lines so a stuck stage doesn't spam,
			// while still advancing on any real change.
			const last = s.lines[s.lines.length - 1];
			if (last && last.text === text && last.level === level) return s;
			const line: RunLogLine = { id: ++seq, t: Date.now(), text, level };
			const base =
				s.lines.length >= MAX_LINES ? s.lines.slice(s.lines.length - MAX_LINES + 1) : s.lines;
			return { lines: [...base, line] };
		}),
	clear: () => set({ lines: [] }),
	setOpen: (open) => set({ open }),
}));

/** Convenience for non-React callers (the run pipeline). */
export function logRun(text: string, level: RunLogLine["level"] = "info"): void {
	useRunLogStore.getState().push(text, level);
}
