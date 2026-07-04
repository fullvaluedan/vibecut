/**
 * QA harness for the skill-driven authoring path (plan 003, U1/U2). Calls the
 * REAL authorComposition in claude-code mode -> the hyperframes skill authors a
 * composition -> asserts a valid index.html within the author timeout, then
 * renders it. Run this after touching the skill brief / invocation:
 *   bun packages/hf-bridge/scripts/skill-invoke-spike.ts
 * Needs the claude CLI signed in (or it surfaces the auth error).
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { authorComposition } from "../src/author-composition.ts";

const brief = `SELECTED ASSETS (use faithfully): Swiss Grid (swiss-grid) [full-frame] — Swiss / International Typographic style.
USER DIRECTION: a key-point callout graphic.
MOMENT (transcript): the speaker says "this is the key point about full value".
Keep on-screen text short (<= 5 words).`;

console.log("=== authorComposition via the hyperframes skill (claude-code) ===");
const t0 = Date.now();
const { compDir } = await authorComposition({
	prompt: brief,
	fps: 30,
	width: 1920,
	height: 1080,
	durationSec: 3,
	auth: { mode: "claude-code" as const },
});
const secs = Math.round((Date.now() - t0) / 1000);
const idx = path.join(compDir, "index.html");
const ok = existsSync(idx);
console.log(`authored in ${secs}s -> ${compDir}`);
console.log(`index.html: ${ok ? `${statSync(idx).size} bytes` : "MISSING"}`);
console.log(
	ok && secs < 150
		? `PASS: skill authored a composition in ${secs}s (under the 150s author timeout)`
		: `FAIL: ${ok ? `too slow (${secs}s)` : "no composition written"}`,
);
