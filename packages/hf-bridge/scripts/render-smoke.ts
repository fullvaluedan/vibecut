/**
 * HyperFrames render smoke harness (MANUAL — needs Chrome + ffmpeg + network).
 *
 * Drives the REAL hf-bridge render/bake path end-to-end against the pinned
 * `hyperframes` CLI across every template × look × setting combo + the first few
 * registry bakes, then ffprobe-verifies each output (dimensions, duration, codec,
 * non-empty). Run after bumping the pinned `hyperframes` version to prove the
 * renderer flags, comp-shell schema, and templates still work before shipping the
 * bump. Not a unit test (spawns headless Chrome + fetches the live registry).
 *
 *   bun packages/hf-bridge/scripts/render-smoke.ts
 *
 * Exits 0 always; read the SUMMARY line + the JSON written to the OS temp dir.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HF_TEMPLATES, renderTemplateJob, bakeRegistryItem } from "../src/index.ts";
import { resolveRegistryBase } from "../src/registry-ref.ts";

type Probe = {
	durationSec: number;
	width?: number;
	height?: number;
	codec?: string;
	sizeBytes: number;
};

function ffprobe(file: string): Probe | null {
	if (!existsSync(file)) return null;
	const r = spawnSync(
		"ffprobe",
		["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) return null;
	try {
		const j = JSON.parse(r.stdout);
		const v = (j.streams || []).find((s: any) => s.codec_type === "video");
		return {
			durationSec: Number(j.format?.duration),
			width: v?.width,
			height: v?.height,
			codec: v?.codec_name,
			sizeBytes: statSync(file).size,
		};
	} catch {
		return null;
	}
}

function buildVars(tpl: any, look: "A" | "B"): Record<string, any> {
	const vars: Record<string, any> = {};
	for (const v of tpl.variables) vars[v.id] = v.default;
	if (look === "B") {
		for (const v of tpl.variables) {
			if (v.type === "color") vars[v.id] = "#FF3366";
			else if (v.type === "string") vars[v.id] = `Smoke ${tpl.id}`;
			else if (v.type === "enum" && v.options?.length) {
				const alt = v.options.find((o: any) => o.value !== v.default) ?? v.options[0];
				vars[v.id] = alt.value;
			} else if (v.type === "boolean") vars[v.id] = !v.default;
		}
	}
	return vars;
}

function clamp(n: number, lo: number, hi: number) {
	return Math.min(Math.max(n, lo), hi);
}
function pickDuration(tpl: any, kind: string): number {
	const mn = tpl.minDurationSec,
		mx = tpl.maxDurationSec;
	if (kind === "min") return mn;
	if (kind === "max") return clamp(Math.min(mx, 6), mn, mx);
	if (kind === "short") return clamp(2, mn, mx);
	return clamp((mn + mx) / 2, mn, Math.min(mx, 5)); // mid
}

const SETTINGS = [
	{ label: "1080p@30 min default", fps: 30, width: 1920, height: 1080, dur: "min", look: "A" as const },
	{ label: "vertical@24 mid lookB", fps: 24, width: 1080, height: 1920, dur: "mid", look: "B" as const },
	{ label: "720p@30 max default", fps: 30, width: 1280, height: 720, dur: "max", look: "A" as const },
	{ label: "square@60 short lookB", fps: 60, width: 1080, height: 1080, dur: "short", look: "B" as const },
];

const results: any[] = [];

function record(id: string, kind: string, ok: boolean, ms: number, extra: any) {
	results.push({ id, kind, ok, ms, ...extra });
	const p: Probe | undefined = extra.probe;
	const dims = p ? `${p.width}x${p.height}` : "-";
	const dur = p && Number.isFinite(p.durationSec) ? `${p.durationSec.toFixed(2)}s` : "-";
	const kb = p ? `${(p.sizeBytes / 1024).toFixed(0)}KB` : "-";
	const codec = p?.codec ?? "-";
	const err = extra.error ? `  ERR: ${extra.error}` : "";
	console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${dims} ${dur} ${kb} ${codec}  ${ms}ms${err}`);
}

console.log(`=== HyperFrames smoke: ${HF_TEMPLATES.length} templates × ${SETTINGS.length} settings + bakes ===`);

for (const tpl of HF_TEMPLATES) {
	for (const s of SETTINGS) {
		const durationSec = pickDuration(tpl, s.dur);
		const expected = clamp(durationSec, tpl.minDurationSec, tpl.maxDurationSec);
		const variables = buildVars(tpl, s.look);
		const id = `${tpl.id} · ${s.label}`;
		const t0 = Date.now();
		try {
			const { videoPath } = await renderTemplateJob({
				templateId: tpl.id,
				durationSec,
				fps: s.fps,
				width: s.width,
				height: s.height,
				variables,
			});
			const probe = ffprobe(videoPath);
			const dimsMatch = !!probe && probe.width === s.width && probe.height === s.height;
			const durOk = !!probe && Number.isFinite(probe.durationSec) && Math.abs(probe.durationSec - expected) < 0.6;
			const ok =
				!!probe && probe.sizeBytes > 2048 && !!probe.codec && Number.isFinite(probe.durationSec) && probe.durationSec > 0.2;
			record(id, "template", ok, Date.now() - t0, {
				probe,
				requested: { durationSec: expected, fps: s.fps, width: s.width, height: s.height },
				dimsMatch,
				durOk,
			});
		} catch (e: any) {
			record(id, "template", false, Date.now() - t0, { error: String(e?.message || e).slice(0, 300) });
		}
	}
}

// Registry bakes (panel "bake library" path): discover blocks, bake the first few.
try {
	// Tag-pinned to the installed hyperframes engine version, not `main`. See
	// registry-ref.ts. Throws (no silent main-fallback) if the engine isn't
	// installed or its version can't be read; caught by this try, reported as
	// "bakes skipped" below, same as any other registry-fetch failure.
	const registryBase = resolveRegistryBase();
	const idx: any = await (
		await fetch(`${registryBase}/registry.json`, {
			signal: AbortSignal.timeout(15000),
		})
	).json();
	const byType = (t: string, n: number) =>
		(idx.items || []).filter((i: any) => i.type === t).slice(0, n);
	// Only BLOCKS bake to a standalone droppable clip. Examples are whole-video
	// templates (sub-comps + a __VIDEO_SRC__ placeholder) and components are
	// snippets — neither renders standalone, so the bake smoke covers blocks.
	const toBake = byType("hyperframes:block", 4);
	console.log(`=== bakes: ${toBake.length} registry blocks ===`);
	for (const b of toBake) {
		const id = `bake · ${b.type.split(":")[1]} · ${b.name}`;
		const t0 = Date.now();
		try {
			const { videoPath } = await bakeRegistryItem({
				name: b.name,
				type: b.type,
				fps: 30,
			});
			const probe = ffprobe(videoPath);
			const ok =
				!!probe && probe.sizeBytes > 2048 && !!probe.codec && Number.isFinite(probe.durationSec) && probe.durationSec > 0.2;
			record(id, "bake", ok, Date.now() - t0, { probe });
		} catch (e: any) {
			const msg = String(e?.message || e);
			// A snippet-only component legitimately has no standalone composition —
			// log + skip, don't count it as a render failure.
			if (/no composition file/.test(msg)) {
				console.log(`bake skipped (${b.name}): snippet-only, no composition`);
				continue;
			}
			record(id, "bake", false, Date.now() - t0, { error: msg.slice(0, 300) });
		}
	}
} catch (e: any) {
	console.log("bakes skipped (registry fetch failed):", String(e?.message || e).slice(0, 200));
}

const pass = results.filter((r) => r.ok).length;
const dimWarns = results.filter((r) => r.kind === "template" && r.ok && r.dimsMatch === false).length;
const durWarns = results.filter((r) => r.kind === "template" && r.ok && r.durOk === false).length;
console.log(`\n=== SUMMARY: ${pass}/${results.length} rendered OK · ${dimWarns} dim-mismatch · ${durWarns} duration-off ===`);
const outFile = path.join(os.tmpdir(), "hf-render-smoke-results.json");
writeFileSync(outFile, JSON.stringify({ pass, total: results.length, dimWarns, durWarns, results }, null, 2));
console.log(`wrote ${outFile}`);
