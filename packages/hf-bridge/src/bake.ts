import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { enqueueRender, resolveHyperframesCli, runNode } from "./renderer";
import { fetchRegistryComposition, registryKindDir } from "./registry-fetch";
import { resolveRegistryBase } from "./registry-ref";

/**
 * The "bake library": registry items that are full standalone HyperFrames
 * compositions (own dimensions, duration, GSAP timeline) — blocks, full-frame
 * examples, and any composition-bearing component. Native motion templates can't
 * reproduce them (maps, charts, social cards, designed layouts), so we render
 * each one ONCE through the pinned hyperframes CLI to a cached transparent WebM
 * and reuse that file for every drop. The cache key folds in the composition's
 * content hash, so a registry update re-bakes automatically.
 *
 * The default registry base (when `job.registryBase` is not given) resolves
 * to the git tag matching the installed `hyperframes` engine version, not
 * `main`. See registry-ref.ts for why.
 */

export interface BakeJob {
	/** Registry item name, e.g. "yt-lower-third". */
	name: string;
	fps: number;
	/** Registry item type (e.g. "hyperframes:example"); defaults to a block. */
	type?: string;
	/**
	 * Override for tests; defaults to the tag-pinned registry matching the
	 * installed hyperframes engine (see registry-ref.ts), not `main`.
	 */
	registryBase?: string;
}

export interface BakeOutcome {
	/** Absolute path to the cached transparent WebM. */
	videoPath: string;
	/** Cache key (also the baked dir name) — stable id for this exact bake. */
	bakeKey: string;
	title: string;
	width: number;
	height: number;
	durationSec: number;
	/** True when served from cache without re-rendering. */
	cached: boolean;
}

/** Baked items persist here, separate from per-run comps under generated/. */
export function bakedRoot(): string {
	return path.join(os.homedir(), ".framecut", "baked");
}

async function fetchOk(url: string): Promise<Response> {
	const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
	if (!res.ok) {
		throw new Error(`Could not fetch ${url} (${res.status})`);
	}
	return res;
}

/**
 * Renders a registry item (block / full-frame example / composition-bearing
 * component) to a cached transparent WebM. Idempotent: a second call with the
 * same item + dims + fps returns the cached file instantly. An item with no
 * composition file (a snippet-only component) cannot be baked standalone and
 * throws a clear error.
 */
export async function bakeRegistryItem(job: BakeJob): Promise<BakeOutcome> {
	const base = job.registryBase ?? resolveRegistryBase();
	const fps = Math.round(job.fps) || 30;
	const type = job.type ?? "hyperframes:block";
	const dir = registryKindDir(type);

	const { compFile, compHtml, files, title, width, height, durationSec } =
		await fetchRegistryComposition({
			name: job.name,
			type,
			registryBase: base,
		});
	if (!compFile) {
		throw new Error(
			`"${job.name}" has no composition file to render. It cannot be baked standalone.`,
		);
	}

	const hash = createHash("sha256")
		.update(compHtml)
		.update(`|${width}x${height}@${fps}|${type}`)
		.digest("hex")
		.slice(0, 16);
	const bakeKey = `${job.name}-${width}x${height}-${fps}-${hash}`;
	const compDir = path.join(bakedRoot(), bakeKey);
	const outPath = path.join(compDir, "out.webm");

	if (existsSync(outPath)) {
		return {
			videoPath: outPath,
			bakeKey,
			title,
			width,
			height,
			durationSec,
			cached: true,
		};
	}

	await mkdir(compDir, { recursive: true });
	// The composition becomes index.html at the comp root, so its relative
	// asset refs (e.g. "assets/avatar.jpg") resolve against the asset targets.
	await writeFile(path.join(compDir, "index.html"), compHtml, "utf8");
	for (const f of files) {
		if (f === compFile) continue;
		const buf = Buffer.from(
			await (
				await fetchOk(`${base}/${dir}/${job.name}/${f.path}`)
			).arrayBuffer(),
		);
		// The registry-supplied target/path is untrusted — contain it inside the
		// bake dir so a crafted entry can't write attacker bytes elsewhere on disk.
		const target = path.resolve(compDir, f.target ?? f.path);
		const root = path.resolve(compDir);
		if (target !== root && !target.startsWith(root + path.sep)) {
			throw new Error(
				`Refusing to write a registry file outside the bake dir: ${f.target ?? f.path}`,
			);
		}
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, buf);
	}
	await writeFile(
		path.join(compDir, "bake.json"),
		JSON.stringify(
			{
				name: job.name,
				title,
				width,
				height,
				durationSec,
				fps,
				sourceHash: hash,
				createdAt: new Date().toISOString(),
			},
			null,
			2,
		),
		"utf8",
	);

	const cli = resolveHyperframesCli();
	const { code, output } = await enqueueRender(() =>
		runNode(
			[
				cli,
				"render",
				"--format",
				"webm",
				"--quality",
				"standard",
				"--fps",
				String(fps),
				"--output",
				outPath,
			],
			compDir,
		),
	);
	if (code !== 0 || !existsSync(outPath)) {
		throw new Error(
			`hyperframes bake failed (exit ${code}):\n${output.slice(-4000)}`,
		);
	}

	return {
		videoPath: outPath,
		bakeKey,
		title,
		width,
		height,
		durationSec,
		cached: false,
	};
}

/** @deprecated renamed to bakeRegistryItem; kept for existing callers/tests. */
export const bakeRegistryBlock = bakeRegistryItem;
