/**
 * Batch QA for the skill-driven RUN HYPERFRAMES path. For each registry asset it
 * builds a panel-style brief naming that asset, authors a graphic through the REAL
 * hyperframes skill (authorComposition, claude-code), renders it, and reports
 * pass/fail + timing + the comp dir (so outputs can be eyeballed for quality +
 * speaker-safe placement).
 *   bun packages/hf-bridge/scripts/hf-asset-qa.ts [count=10] [offset=0]
 * Needs the claude CLI signed in. Authors run with bounded concurrency; renders
 * serialize through the bridge's render queue.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorComposition } from "../src/author-composition.ts";
import { enqueueRender, resolveHyperframesCli, runNode } from "../src/renderer.ts";

const count = Number(process.argv[2] ?? 10);
const offset = Number(process.argv[3] ?? 0);
const REGISTRY = "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry";
const CONCURRENCY = 3;

interface Row {
	name: string;
	kind: string;
	ok: boolean;
	stage?: string;
	authoredMs?: number;
	totalMs?: number;
	bytes?: number;
	compDir?: string;
	err?: string;
}

function briefFor(item: { name: string; type: string }): string {
	const kind = item.type.split(":")[1] ?? item.type;
	const full = kind === "example" ? " [full-frame]" : "";
	return `SELECTED ASSETS (use faithfully):
  - ${item.name} (${item.name})${full} — a HyperFrames ${kind}; apply its visual style.
USER DIRECTION: a key-point callout that reinforces the spoken line.
MOMENT (transcript, ~3s): the speaker says "this is the key point about delivering full value".
Keep on-screen text short (<= 5 words).`;
}

async function testAsset(item: { name: string; type: string }): Promise<Row> {
	const kind = item.type.split(":")[1] ?? item.type;
	const t0 = Date.now();
	try {
		const { compDir } = await authorComposition({
			prompt: briefFor(item),
			fps: 30,
			width: 1920,
			height: 1080,
			durationSec: 3,
			auth: { mode: "claude-code" as const },
		});
		const authoredMs = Date.now() - t0;
		const indexPath = path.join(compDir, "index.html");
		if (!existsSync(indexPath)) {
			return { name: item.name, kind, ok: false, stage: "author", authoredMs };
		}
		const cli = resolveHyperframesCli();
		const out = path.join(compDir, "out.webm");
		const { code, output } = await enqueueRender(() =>
			runNode(
				[cli, "render", "--format", "webm", "--quality", "standard", "--fps", "30", "--output", out],
				compDir,
			),
		);
		const rendered = code === 0 && existsSync(out);
		const bytes = rendered ? statSync(out).size : 0;
		return {
			name: item.name,
			kind,
			ok: rendered && bytes > 2048,
			stage: rendered ? undefined : "render",
			authoredMs,
			totalMs: Date.now() - t0,
			bytes,
			compDir,
			err: rendered ? undefined : output.slice(-200),
		};
	} catch (e) {
		return {
			name: item.name,
			kind,
			ok: false,
			stage: "error",
			totalMs: Date.now() - t0,
			err: String(e instanceof Error ? e.message : e).slice(0, 200),
		};
	}
}

const idx = (await (await fetch(`${REGISTRY}/registry.json`)).json()) as {
	items?: { name: string; type: string }[];
};
const all = (idx.items ?? []).filter((i) =>
	/hyperframes:(example|block|component)/.test(i.type),
);
const batch = all.slice(offset, offset + count);
console.log(`=== HyperFrames asset QA: ${batch.length} assets (offset ${offset} of ${all.length}) ===`);

const results: Row[] = [];
let cursor = 0;
async function worker(): Promise<void> {
	while (cursor < batch.length) {
		const item = batch[cursor++];
		const n = cursor;
		console.log(`[${n}/${batch.length}] ${item.type.split(":")[1]} ${item.name} ...`);
		const r = await testAsset(item);
		console.log(`    ${r.ok ? "PASS" : "FAIL"} ${item.name} ${r.ok ? `${Math.round((r.totalMs ?? 0) / 1000)}s` : `(${r.stage}${r.err ? ": " + r.err : ""})`}`);
		results.push(r);
	}
}
await Promise.all(
	Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()),
);

console.log("\n=== RESULTS ===");
for (const r of results) {
	console.log(
		`${r.ok ? "PASS" : "FAIL"}  ${r.kind.padEnd(10)} ${r.name.padEnd(26)} ${r.ok ? `${Math.round((r.totalMs ?? 0) / 1000)}s ${r.bytes}b` : `${r.stage}${r.err ? " :: " + r.err : ""}`}`,
	);
}
const pass = results.filter((r) => r.ok).length;
console.log(`\nSUMMARY: ${pass}/${results.length} authored + rendered OK`);
const outFile = path.join(os.tmpdir(), "hf-asset-qa.json");
writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`wrote ${outFile}`);
