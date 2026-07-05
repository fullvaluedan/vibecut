/**
 * Holds the ONE active graphics job and polls its server-side status so the UI shows
 * live progress, a heartbeat, the proof-ready gate, and the finished render. Only one
 * job at a time (renders are heavy and serialized).
 */
import { create } from "zustand";
import {
	approveFullRender,
	cancelGraphicsJob,
	fetchGraphicsStatus,
} from "./run-graphics";
import { isTerminal, type GraphicsJob } from "./job-types";

interface GraphicsJobState {
	job: GraphicsJob | null;
	starting: boolean;
	error: string | null;
	/** True once fullPath has appeared and the caller has NOT yet imported it. */
	pendingImport: string | null;
	/** Begin tracking a freshly-started job id (kicks the poll loop). */
	track: (id: string) => void;
	setStarting: (starting: boolean) => void;
	setError: (error: string | null) => void;
	approve: () => Promise<void>;
	cancel: () => Promise<void>;
	/** Caller marks the finished render consumed (placed on the timeline). */
	clearPendingImport: () => void;
	dismiss: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useGraphicsJobStore = create<GraphicsJobState>((set, get) => {
	const stopPolling = () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	};
	const poll = async (id: string) => {
		const job = await fetchGraphicsStatus(id);
		if (!job) return;
		set({ job });
		if (job.phase === "done" && job.fullPath && get().pendingImport !== job.fullPath) {
			set({ pendingImport: job.fullPath });
		}
		if (isTerminal(job.phase)) stopPolling();
	};

	return {
		job: null,
		starting: false,
		error: null,
		pendingImport: null,
		setStarting: (starting) => set({ starting }),
		setError: (error) => set({ error }),
		track: (id) => {
			stopPolling();
			set({ error: null });
			void poll(id);
			pollTimer = setInterval(() => void poll(id), 2000);
		},
		approve: async () => {
			const id = get().job?.id;
			if (id) await approveFullRender(id);
		},
		cancel: async () => {
			const id = get().job?.id;
			if (id) await cancelGraphicsJob(id);
		},
		clearPendingImport: () => set({ pendingImport: null }),
		dismiss: () => {
			stopPolling();
			set({ job: null, starting: false, error: null, pendingImport: null });
		},
	};
});
