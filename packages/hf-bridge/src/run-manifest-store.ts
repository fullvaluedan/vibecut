/**
 * fs-backed persistence for run manifests (SERVER-only - the client drives the
 * pure state machine in run-manifest.ts and round-trips through the
 * /api/hyperframes/run-manifest route). Manifests live alongside the comp dirs
 * they checkpoint, under <generatedRoot>/run-manifests/<runId>.json.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatedRoot, renderCacheValid } from "./renderer";
import {
	revalidateManifest,
	RUN_ID_PATTERN,
	type CompDirStatus,
	type RunManifest,
} from "./run-manifest";

export function manifestsRoot(root?: string): string {
	return path.join(root ?? generatedRoot(), "run-manifests");
}

export function manifestPath(runId: string, root?: string): string {
	if (!RUN_ID_PATTERN.test(runId)) {
		throw new Error(`Invalid runId: ${runId}`);
	}
	return path.join(manifestsRoot(root), `${runId}.json`);
}

export async function loadRunManifest(
	runId: string,
	root?: string,
): Promise<RunManifest | null> {
	const file = manifestPath(runId, root); // throws on an invalid runId
	try {
		const raw = await readFile(file, "utf8");
		const parsed = JSON.parse(raw) as RunManifest;
		// Shape sanity: a corrupt/mismatched file is ignored, never trusted.
		if (
			parsed.runId !== runId ||
			!Array.isArray(parsed.chunks) ||
			typeof parsed.approved !== "boolean"
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export async function saveRunManifest(
	manifest: RunManifest,
	root?: string,
): Promise<void> {
	const dir = manifestsRoot(root);
	await mkdir(dir, { recursive: true });
	await writeFile(
		manifestPath(manifest.runId, root),
		JSON.stringify(manifest, null, 2),
		"utf8",
	);
}

/** Disk check behind revalidateManifest: does the chunk's comp dir + render hold up? */
export function compDirStatus(compId: string, root?: string): CompDirStatus {
	const compDir = path.join(root ?? generatedRoot(), compId);
	if (!existsSync(path.join(compDir, "index.html"))) return "missing";
	return renderCacheValid(compDir, path.join(compDir, "out.webm"))
		? "valid"
		: "stale";
}

/**
 * Load + revalidate in one step (the route's GET): chunks whose comp dirs or
 * cached renders no longer hold up are downgraded, and the correction is
 * persisted so later runs see it.
 */
export async function loadRevalidatedManifest(
	runId: string,
	root?: string,
): Promise<RunManifest | null> {
	const manifest = await loadRunManifest(runId, root);
	if (!manifest) return null;
	const { manifest: fixed, changed } = revalidateManifest(manifest, (compId) =>
		compDirStatus(compId, root),
	);
	if (changed) await saveRunManifest(fixed, root);
	return fixed;
}
