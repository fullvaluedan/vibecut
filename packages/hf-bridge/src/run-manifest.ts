/**
 * Run-manifest: the pure core of the chunked authored run's checkpoint. One
 * manifest per run (keyed by a scope/brief-derived runId) records every chunk's
 * state so a run survives failure, cancel, and re-run:
 *   pending  - planned, nothing authored yet
 *   probed   - authored + short probe rendered (compId set); full render pending
 *   rendered - full render done and reusable on a later run of the same scope
 *   failed   - last attempt failed; retryable (compId set when authoring had
 *              succeeded, so a retry can re-render without re-authoring)
 *
 * This module is CLIENT-SAFE (no node imports) so the browser run loop can
 * drive the same state machine the server persists; the fs-backed store lives
 * in run-manifest-store.ts (server-only).
 */

export type ManifestChunkState = "pending" | "probed" | "rendered" | "failed";

export interface ManifestChunk {
	index: number;
	startSec: number;
	endSec: number;
	state: ManifestChunkState;
	compId?: string;
	error?: string;
	updatedAt: string;
}

export interface RunManifest {
	runId: string;
	scope: { startSec: number; endSec: number };
	canvas: { width: number; height: number; fps: number };
	/** The user approved this run's probe set (persisted so reuse skips the gate). */
	approved: boolean;
	chunks: ManifestChunk[];
	createdAt: string;
}

/** Manifest files and route params accept only safe run ids. */
export const RUN_ID_PATTERN = /^[\w-]+$/;

/** Legal chunk transitions. Anything else throws (a bug, not a user error). */
const LEGAL: Record<ManifestChunkState, ManifestChunkState[]> = {
	pending: ["probed", "failed"],
	// probed -> pending: the comp dir vanished; re-author from scratch.
	probed: ["rendered", "failed", "pending"],
	// rendered -> probed: the cached full render went stale (Studio edit);
	// re-render only, the approval lineage holds. -> pending: comp dir gone.
	rendered: ["probed", "pending", "failed"],
	// failed -> probed: retry re-authored. -> rendered: retry re-rendered the
	// kept compId. -> pending: comp dir gone, back to re-author.
	failed: ["probed", "rendered", "pending"],
};

export function createRunManifest({
	runId,
	scope,
	canvas,
	chunks,
	now = new Date().toISOString(),
}: {
	runId: string;
	scope: { startSec: number; endSec: number };
	canvas: { width: number; height: number; fps: number };
	chunks: { index: number; startSec: number; endSec: number }[];
	now?: string;
}): RunManifest {
	if (!RUN_ID_PATTERN.test(runId)) {
		throw new Error(`Invalid runId: ${runId}`);
	}
	return {
		runId,
		scope,
		canvas,
		approved: false,
		chunks: chunks.map((c) => ({
			index: c.index,
			startSec: c.startSec,
			endSec: c.endSec,
			state: "pending",
			updatedAt: now,
		})),
		createdAt: now,
	};
}

/**
 * Move one chunk to a new state (returns a NEW manifest; the input is not
 * mutated). `compId`/`error` patch the chunk: a compId is recorded once
 * authoring succeeds, an error is recorded on failure and cleared on success.
 */
export function transitionChunk(
	manifest: RunManifest,
	index: number,
	next: ManifestChunkState,
	patch: { compId?: string | null; error?: string | null; now?: string } = {},
): RunManifest {
	const chunk = manifest.chunks.find((c) => c.index === index);
	if (!chunk) throw new Error(`No chunk ${index} in run ${manifest.runId}`);
	if (!LEGAL[chunk.state].includes(next)) {
		throw new Error(
			`Illegal chunk transition ${chunk.state} -> ${next} (chunk ${index}, run ${manifest.runId})`,
		);
	}
	return {
		...manifest,
		chunks: manifest.chunks.map((c) =>
			c.index !== index
				? c
				: {
						...c,
						state: next,
						compId:
							patch.compId === null
								? undefined
								: (patch.compId ?? c.compId),
						error:
							patch.error === null || next !== "failed"
								? undefined
								: (patch.error ?? c.error),
						updatedAt: patch.now ?? new Date().toISOString(),
					},
		),
	};
}

export function markApproved(manifest: RunManifest): RunManifest {
	return { ...manifest, approved: true };
}

/** Geometry tolerance for matching a stored chunk to a fresh chunk plan. */
const GEOMETRY_EPS_SEC = 0.5;

/**
 * Chunks of a fresh plan that can be REUSED from a previous run: same geometry
 * and fully rendered, with a compId to re-render from. Reused chunks skip
 * authoring AND the probe gate (they were approved when first rendered; the
 * runId only matches when the brief inputs are unchanged).
 */
export function matchReusableChunks(
	manifest: RunManifest,
	plan: { index: number; startSec: number; endSec: number }[],
): Map<number, ManifestChunk> {
	const out = new Map<number, ManifestChunk>();
	for (const p of plan) {
		const c = manifest.chunks.find((m) => m.index === p.index);
		if (
			c &&
			c.state === "rendered" &&
			c.compId &&
			Math.abs(c.startSec - p.startSec) < GEOMETRY_EPS_SEC &&
			Math.abs(c.endSec - p.endSec) < GEOMETRY_EPS_SEC
		) {
			out.set(p.index, c);
		}
	}
	return out;
}

/** What the comp dir behind a chunk's compId looks like on disk. */
export type CompDirStatus = "valid" | "stale" | "missing";

/**
 * Re-check a loaded manifest against the comp dirs on disk (the check itself is
 * injected so this stays pure):
 *   rendered + missing dir  -> pending (re-author), compId dropped
 *   rendered + stale render -> probed (re-render only, approval holds)
 *   probed/failed + missing -> pending (re-author), compId dropped
 * Returns the corrected manifest and whether anything changed.
 */
export function revalidateManifest(
	manifest: RunManifest,
	compDirStatus: (compId: string) => CompDirStatus,
): { manifest: RunManifest; changed: boolean } {
	let changed = false;
	const chunks = manifest.chunks.map((c) => {
		if (!c.compId) return c;
		const status = compDirStatus(c.compId);
		if (status === "valid") return c;
		changed = true;
		if (status === "missing") {
			return {
				...c,
				state: "pending" as const,
				compId: undefined,
				error: undefined,
				updatedAt: new Date().toISOString(),
			};
		}
		// stale: only a rendered chunk can go stale (its cached out.webm is older
		// than an edited index.html); it drops back to probed for a re-render.
		if (c.state === "rendered") {
			return { ...c, state: "probed" as const, updatedAt: new Date().toISOString() };
		}
		return c;
	});
	return { manifest: changed ? { ...manifest, chunks } : manifest, changed };
}
