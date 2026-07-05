/**
 * Graphics-generate job model (Remotion / HyperFrames graphics passes driven by the
 * dan-video skill). A job runs OUTSIDE the request lifecycle in a detached worker
 * (`scripts/graphics-worker.mjs`) so a ~2hr render survives page reloads; the worker
 * writes its state to `<TEMP_ROOT>/<id>/job.json` and the UI polls it.
 *
 * Shared types only (no node/browser imports) so both the API routes and the client
 * orchestrator can import them.
 */

export type GraphicsEngine = "remotion" | "hyperframes";

export type GraphicsPhase =
	| "extracting" // writing source.mp4 + transcript.json into the engine project
	| "generating" // the agentic claude session writing the composition
	| "proof-rendering" // the fast ~100s proof clip
	| "proof-ready" // proof done, waiting for the user to approve the full render
	| "full-rendering" // the ~2hr full render
	| "importing" // copying the output + handing it back to the timeline
	| "done"
	| "error"
	| "cancelled";

/** One line in the job's live log (shown in the panel). */
export interface GraphicsLogLine {
	/** epoch ms */
	t: number;
	text: string;
	level: "info" | "warn" | "error";
}

/** The full job state, mirrored to `<TEMP_ROOT>/<id>/job.json`. */
export interface GraphicsJob {
	id: string;
	engine: GraphicsEngine;
	phase: GraphicsPhase;
	/** 0..1 within the CURRENT phase (e.g. render frame progress). */
	progress: number;
	/** One-line human status for the button/panel header. */
	message: string;
	log: GraphicsLogLine[];
	/** epoch ms, bumped every few seconds by the worker so the UI can prove it is
	 * alive; a stale heartbeat (> ~30s) means the worker died / is stuck. */
	heartbeatAt: number;
	createdAt: number;
	/** Absolute path to the proof clip once `proof-ready`. */
	proofPath?: string;
	/** Absolute path to the full render once `done`. */
	fullPath?: string;
	error?: string;
}

/** Phases the UI treats as terminal (stop polling). */
export const TERMINAL_PHASES: readonly GraphicsPhase[] = [
	"done",
	"error",
	"cancelled",
];

export function isTerminal(phase: GraphicsPhase): boolean {
	return TERMINAL_PHASES.includes(phase);
}

/** A heartbeat older than this (ms) means the worker is presumed dead/stuck. */
export const HEARTBEAT_STALE_MS = 30_000;

export function isHeartbeatStale(job: Pick<GraphicsJob, "heartbeatAt">, now: number): boolean {
	return now - job.heartbeatAt > HEARTBEAT_STALE_MS;
}
