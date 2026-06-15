import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { enqueueRender, resolveHyperframesCli, runNode } from "./renderer";

/**
 * The "bake library": registry BLOCKS are full standalone HyperFrames
 * compositions (own dimensions, duration, GSAP timeline). Native motion
 * templates can't reproduce them (maps, charts, social cards, logo outros),
 * so we render each one ONCE through the pinned hyperframes CLI to a cached
 * transparent WebM and reuse that file for every drop. The cache key folds in
 * the composition's content hash, so a registry update re-bakes automatically.
 */

const REGISTRY_BASE =
	"https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry";

export interface BakeJob {
	/** Registry block name, e.g. "yt-lower-third". */
	name: string;
	fps: number;
	/** Override for tests; defaults to the official registry. */
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

interface RegistryFile {
	path: string;
	target?: string;
	type?: string;
}

interface RegistryItem {
	name: string;
	type: string;
	title?: string;
	description?: string;
	duration?: number;
	dimensions?: { width?: number; height?: number };
	files?: RegistryFile[];
}

/** Baked blocks persist here, separate from per-run comps under generated/. */
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
 * Renders a registry block to a cached transparent WebM. Idempotent: a second
 * call with the same block + dims + fps returns the cached file instantly.
 */
export async function bakeRegistryBlock(job: BakeJob): Promise<BakeOutcome> {
	const base = job.registryBase ?? REGISTRY_BASE;
	const fps = Math.round(job.fps) || 30;

	const item = (await (
		await fetchOk(`${base}/blocks/${job.name}/registry-item.json`)
	).json()) as RegistryItem;
	if (item.type !== "hyperframes:block") {
		throw new Error(
			`"${job.name}" is a ${item.type}, not a block — only blocks can be baked yet.`,
		);
	}

	const width = item.dimensions?.width ?? 1920;
	const height = item.dimensions?.height ?? 1080;
	const durationSec = item.duration ?? 5;
	const files = item.files ?? [];
	const compFile = files.find((f) => f.type === "hyperframes:composition");
	if (!compFile) {
		throw new Error(`Block "${job.name}" has no composition file to render.`);
	}

	// Pull the composition first — it doubles as the content-hash source.
	const compHtml = await (
		await fetchOk(`${base}/blocks/${job.name}/${compFile.path}`)
	).text();

	const hash = createHash("sha256")
		.update(compHtml)
		.update(`|${width}x${height}@${fps}`)
		.digest("hex")
		.slice(0, 16);
	const bakeKey = `${job.name}-${width}x${height}-${fps}-${hash}`;
	const compDir = path.join(bakedRoot(), bakeKey);
	const outPath = path.join(compDir, "out.webm");

	if (existsSync(outPath)) {
		return {
			videoPath: outPath,
			bakeKey,
			title: item.title ?? job.name,
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
				await fetchOk(`${base}/blocks/${job.name}/${f.path}`)
			).arrayBuffer(),
		);
		const target = path.join(compDir, f.target ?? f.path);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, buf);
	}
	await writeFile(
		path.join(compDir, "bake.json"),
		JSON.stringify(
			{
				name: job.name,
				title: item.title ?? job.name,
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
		title: item.title ?? job.name,
		width,
		height,
		durationSec,
		cached: false,
	};
}
