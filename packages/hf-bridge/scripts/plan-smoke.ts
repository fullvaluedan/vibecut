/**
 * HyperFrames PLAN-step smoke harness (MANUAL — needs a live AI connection).
 *
 * Drives the REAL planEffects() (the LLM step that decides WHICH motion templates
 * to place where) across a sample transcript + several panel-setting variants
 * (default, a visual look, an allow-list, a free-form direction), then validates
 * each returned plan against the template registry. Complements render-smoke.ts,
 * which only covers the render engine.
 *
 *   bun packages/hf-bridge/scripts/plan-smoke.ts
 *
 * Uses claude-code auth (the local `claude` CLI) by default — consumes a little
 * Claude usage. Exits 0 always; read the SUMMARY + each printed plan.
 */
import { HF_TEMPLATES, planEffects, type TranscriptSegment } from "../src/index.ts";

const AUTH = { mode: "claude-code" as const };

const SEGMENTS: TranscriptSegment[] = [
	{ text: "Hey everyone, I'm Dan Reola, founder of FrameCut.", start: 0, end: 4 },
	{ text: "Today I want to show you the one feature that changes everything.", start: 4, end: 9 },
	{ text: "In our tests, 87% of editors finished their cut faster.", start: 9, end: 14 },
	{ text: "Quick tip: you can drag any clip to reorder it instantly.", start: 14, end: 19 },
	{ text: "Now let's move on to the second part: exporting your video.", start: 19, end: 24 },
	{ text: "Export is where most tools fall apart, but not here.", start: 24, end: 30 },
];
const TOTAL = 30;
const IDS = new Set(HF_TEMPLATES.map((t) => t.id));
const byId = new Map(HF_TEMPLATES.map((t) => [t.id, t]));

const VARIANTS: { label: string; opts: any }[] = [
	{ label: "default", opts: {} },
	{
		label: "look=Editorial",
		opts: { look: { name: "Editorial", description: "premium documentary feel, slower pacing, prefers section breaks + lower thirds" } },
	},
	{ label: "allow=[lower-third,number-pop]", opts: { allowedTemplateIds: ["lower-third", "number-pop"] } },
	{ label: 'direction="only lower thirds, minimal"', opts: { direction: "Only use lower thirds. Keep it minimal." } },
];

const results: any[] = [];

for (const v of VARIANTS) {
	const t0 = Date.now();
	try {
		const plan = await planEffects({ segments: SEGMENTS, totalDurationSec: TOTAL, auth: AUTH, ...v.opts });
		const items = Array.isArray(plan.items) ? plan.items : [];
		const issues: string[] = [];
		for (const it of items) {
			const tpl = byId.get(it.templateId);
			if (!tpl) issues.push(`unknown templateId ${it.templateId}`);
			else {
				if (it.durationSec < tpl.minDurationSec - 0.01 || it.durationSec > tpl.maxDurationSec + 0.01)
					issues.push(`${it.templateId} dur ${it.durationSec} out of [${tpl.minDurationSec},${tpl.maxDurationSec}]`);
			}
			if (it.startSec < 0 || it.startSec >= TOTAL) issues.push(`${it.templateId} start ${it.startSec} out of [0,${TOTAL})`);
			if (!it.variables || typeof it.variables !== "object") issues.push(`${it.templateId} missing variables`);
		}
		// overlap check (sorted by start)
		const sorted = [...items].sort((a, b) => a.startSec - b.startSec);
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i].startSec < sorted[i - 1].startSec + sorted[i - 1].durationSec - 0.01)
				issues.push(`overlap ${sorted[i - 1].templateId}↔${sorted[i].templateId}`);
		}
		if (v.opts.allowedTemplateIds) {
			const allow = new Set(v.opts.allowedTemplateIds);
			for (const it of items) if (!allow.has(it.templateId)) issues.push(`allow-list violated: ${it.templateId}`);
		}
		const ok = items.length > 0 && issues.length === 0;
		results.push({ label: v.label, ok, ms: Date.now() - t0, count: items.length, issues, usage: plan.usage });
		console.log(`${ok ? "PASS" : items.length === 0 ? "EMPTY" : "WARN"}  ${v.label}  ${items.length} effects  ${Date.now() - t0}ms${issues.length ? "  ISSUES: " + issues.join("; ") : ""}`);
		for (const it of items) {
			const vars = Object.entries(it.variables || {}).map(([k, val]) => `${k}=${String(val).slice(0, 24)}`).join(" ");
			console.log(`     ${it.startSec.toFixed(1)}s +${it.durationSec.toFixed(1)}s  ${it.templateId}  ${vars}`);
		}
	} catch (e: any) {
		results.push({ label: v.label, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 400) });
		console.log(`FAIL  ${v.label}  ERROR: ${String(e?.message || e).slice(0, 300)}`);
	}
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== PLAN SUMMARY: ${pass}/${results.length} produced a valid plan ===`);
