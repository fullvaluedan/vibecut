import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getTemplate } from "./templates/index";
import type { RenderJob, RenderOutcome } from "./types";

/**
 * Locates the pinned hyperframes package by walking up from cwd.
 * Deliberately avoids require()/import so bundlers (Turbopack dev) never
 * try to statically analyze the lookup.
 */
export function findHyperframesPackageDir(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		// Hoisted layout (npm/pnpm) and bun's isolated layout for this package.
		const candidates = [
			path.join(dir, "node_modules", "hyperframes"),
			path.join(dir, "packages", "hf-bridge", "node_modules", "hyperframes"),
		];
		// Bun's content store: node_modules/.bun/hyperframes@<version>/node_modules/hyperframes
		const bunStore = path.join(dir, "node_modules", ".bun");
		if (existsSync(bunStore)) {
			for (const entry of readdirSync(bunStore)) {
				if (entry.startsWith("hyperframes@")) {
					candidates.push(
						path.join(bunStore, entry, "node_modules", "hyperframes"),
					);
				}
			}
		}
		for (const candidate of candidates) {
			if (existsSync(path.join(candidate, "package.json"))) {
				return candidate;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		"hyperframes package not found in node_modules — run `bun install` in the repo root",
	);
}

export function resolveHyperframesCli(): string {
	const pkgDir = findHyperframesPackageDir();
	const pkg = JSON.parse(
		readFileSync(path.join(pkgDir, "package.json"), "utf8"),
	) as { bin?: string | Record<string, string> };
	const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hyperframes;
	if (!binRel) {
		throw new Error("hyperframes package has no bin entry");
	}
	return path.join(pkgDir, binRel);
}

/** Comp sources persist here so re-renders/template swaps never lose them. */
export function generatedRoot(): string {
	return path.join(os.homedir(), ".framecut", "generated");
}

/** The web app may run under Bun; the hyperframes CLI needs real Node. */
function nodeBinary(): string {
	if (process.env.FRAMECUT_NODE) return process.env.FRAMECUT_NODE;
	const isBun = path.basename(process.execPath).toLowerCase().startsWith("bun");
	return isBun ? "node" : process.execPath;
}

export function runNode(args: string[], cwd: string): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(nodeBinary(), args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let output = "";
		child.stdout.on("data", (d) => (output += d.toString()));
		child.stderr.on("data", (d) => (output += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, output }));
	});
}

/**
 * Global render serialization: every hyperframes `render` (templates, authored
 * comps, bakes) goes through this promise-chain mutex so concurrent requests —
 * a chunked authored run, a 3-version variant batch, parallel bakes — never
 * spawn more than ONE headless Chromium at a time. Critical on constrained
 * machines: each render is a ~0.5–1 GB browser process. Studio (`preview`, a
 * long-lived server) deliberately does NOT go through here.
 */
let renderChain: Promise<unknown> = Promise.resolve();
export function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
	const run = renderChain.then(task, task);
	renderChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * A previously rendered out.webm is reusable iff it's newer than every source
 * input (index.html / vars.json). A Studio edit bumps index.html's mtime, so it
 * correctly forces a fresh render; a no-op re-run reuses the cached file.
 */
export function renderCacheValid(compDir: string, outPath: string): boolean {
	if (!existsSync(outPath)) return false;
	try {
		const outMs = statSync(outPath).mtimeMs;
		for (const src of ["index.html", "vars.json"]) {
			const p = path.join(compDir, src);
			if (existsSync(p) && statSync(p).mtimeMs > outMs) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Renders one template instance to a transparent WebM.
 * Scaffolds a persistent comp dir, writes index.html + vars.json, then runs
 * the pinned hyperframes CLI: render --format webm.
 */
export async function renderTemplateJob(job: RenderJob): Promise<RenderOutcome> {
	const template = getTemplate(job.templateId);
	if (!template) {
		throw new Error(`Unknown template: ${job.templateId}`);
	}

	const durationSec = Math.min(
		Math.max(job.durationSec, template.minDurationSec),
		template.maxDurationSec,
	);

	const compId = randomUUID();
	const compDir = path.join(generatedRoot(), compId);
	await mkdir(compDir, { recursive: true });

	const html = template.buildCompHtml({
		width: job.width,
		height: job.height,
		durationSec,
	});
	await writeFile(path.join(compDir, "index.html"), html, "utf8");
	await writeFile(
		path.join(compDir, "vars.json"),
		JSON.stringify(job.variables, null, 2),
		"utf8",
	);
	await writeFile(
		path.join(compDir, "framecut.json"),
		JSON.stringify(
			{
				templateId: job.templateId,
				durationSec,
				fps: job.fps,
				width: job.width,
				height: job.height,
				variables: job.variables,
				createdAt: new Date().toISOString(),
			},
			null,
			2,
		),
		"utf8",
	);

	const cli = resolveHyperframesCli();
	const outPath = path.join(compDir, "out.webm");
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
				String(job.fps),
				"--variables-file",
				"vars.json",
				"--output",
				outPath,
			],
			compDir,
		),
	);

	if (code !== 0 || !existsSync(outPath)) {
		throw new Error(
			`hyperframes render failed (exit ${code}):\n${output.slice(-4000)}`,
		);
	}

	return { videoPath: outPath, compDir };
}

/**
 * Re-renders an EXISTING comp dir exactly as it is on disk — used to pull
 * edits made in HyperFrames Studio back into the editor. Unlike
 * renderTemplateJob, nothing is scaffolded or overwritten.
 */
export async function renderCompDir({
	compId,
	fps,
}: {
	compId: string;
	fps?: number;
}): Promise<RenderOutcome> {
	const compDir = path.join(generatedRoot(), compId);
	if (!existsSync(path.join(compDir, "index.html"))) {
		throw new Error(`Comp source not found for ${compId} — re-render from the template instead.`);
	}
	let effectiveFps = fps;
	if (!effectiveFps) {
		try {
			const meta = JSON.parse(
				readFileSync(path.join(compDir, "framecut.json"), "utf8"),
			) as { fps?: number };
			effectiveFps = meta.fps;
		} catch {
			// fall through to default
		}
	}

	const cli = resolveHyperframesCli();
	const outPath = path.join(compDir, "out.webm");
	// Reuse an up-to-date render instead of spawning a browser again.
	if (renderCacheValid(compDir, outPath)) {
		return { videoPath: outPath, compDir };
	}
	const args = [
		cli,
		"render",
		"--format",
		"webm",
		"--quality",
		"standard",
		"--fps",
		String(effectiveFps ?? 30),
		"--output",
		outPath,
	];
	if (existsSync(path.join(compDir, "vars.json"))) {
		args.push("--variables-file", "vars.json");
	}
	const { code, output } = await enqueueRender(() => runNode(args, compDir));
	if (code !== 0 || !existsSync(outPath)) {
		throw new Error(
			`hyperframes render failed (exit ${code}):\n${output.slice(-4000)}`,
		);
	}
	return { videoPath: outPath, compDir };
}

/**
 * HyperFrames Studio singleton: serves one comp dir via `hyperframes preview`
 * so the user can edit it visually. Starting a different comp replaces the
 * previous server (same port).
 */
const STUDIO_PORT = 3217;
let studio: {
	compId: string;
	child: ReturnType<typeof spawn>;
} | null = null;

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (res.ok || res.status === 404) return true;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

/** The running Studio decides its own project id — ask it instead of guessing. */
async function resolveStudioUrl(): Promise<string> {
	try {
		const res = await fetch(`http://localhost:${STUDIO_PORT}/api/projects`, {
			signal: AbortSignal.timeout(3000),
		});
		const data = (await res.json()) as { projects?: { id: string }[] };
		const id = data.projects?.[0]?.id;
		if (id) {
			return `http://localhost:${STUDIO_PORT}/#project/${encodeURIComponent(id)}`;
		}
	} catch {
		// fall through
	}
	return `http://localhost:${STUDIO_PORT}/`;
}

export async function startStudio({
	compId,
}: {
	compId: string;
}): Promise<{ url: string }> {
	const compDir = path.join(generatedRoot(), compId);
	if (!existsSync(path.join(compDir, "index.html"))) {
		throw new Error(`Comp source not found for ${compId}`);
	}

	if (studio && studio.compId === compId && studio.child.exitCode === null) {
		return { url: await resolveStudioUrl() };
	}
	if (studio && studio.child.exitCode === null) {
		studio.child.kill();
		studio = null;
		// Give the old server a moment to release the port.
		await new Promise((r) => setTimeout(r, 750));
	}

	const cli = resolveHyperframesCli();
	const child = spawn(
		nodeBinary(),
		[cli, "preview", "--port", String(STUDIO_PORT)],
		{
			cwd: compDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", BROWSER: "none" },
			detached: false,
		},
	);
	child.on("error", () => {
		studio = null;
	});
	child.on("close", () => {
		if (studio?.child === child) studio = null;
	});
	studio = { compId, child };

	const up = await waitForHttp(`http://localhost:${STUDIO_PORT}/`, 30000);
	if (!up) {
		child.kill();
		studio = null;
		throw new Error("HyperFrames Studio did not start within 30s");
	}
	return { url: await resolveStudioUrl() };
}
