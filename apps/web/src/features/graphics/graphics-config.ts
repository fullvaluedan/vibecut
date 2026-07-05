/**
 * Filesystem locations for the graphics-generate pipeline. Server-only (used by the
 * API routes); the worker script receives these as argv so it needs no import.
 *
 * Overridable by env for other machines; defaults match Dan's setup.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Absolute path to the detached worker script. The Next server's cwd is unstable
 * (repo root vs apps/web depending on the runner), so walk up looking for it.
 */
export function resolveWorkerScript(): string {
	const rel = path.join("scripts", "graphics-worker.mjs");
	let dir = process.cwd();
	for (let i = 0; i < 6; i++) {
		const candidate = path.join(dir, rel);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Last resort: assume repo-root two levels above apps/web.
	return path.resolve(process.cwd(), "..", "..", rel);
}

/** Where job dirs + output files live (Dan's choice). */
export const TEMP_ROOT = process.env.GRAPHICS_TEMP_ROOT ?? "D:\\Claude\\_temp";

/** The Remotion project holding the danL kit (Remotion 4.x + src/danL). */
export const REMOTION_PROJECT_DIR =
	process.env.GRAPHICS_REMOTION_DIR ?? "D:\\Hermes\\remotion-v2";

/** Per-job working dir: source copy, proof.mp4, full.mp4, job.json, gen logs. */
export function jobDir(id: string): string {
	return path.join(TEMP_ROOT, id);
}

/** The polled status file the worker keeps current. */
export function jobFilePath(id: string): string {
	return path.join(jobDir(id), "job.json");
}

/** A control file the render-full route drops to release the proof-ready gate. */
export function approveFlagPath(id: string): string {
	return path.join(jobDir(id), "approve-full");
}

/** A control file the cancel route drops so the worker aborts at the next checkpoint. */
export function cancelFlagPath(id: string): string {
	return path.join(jobDir(id), "cancel");
}
