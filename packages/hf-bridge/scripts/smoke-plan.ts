/**
 * Smoke test for the effect planner (claude-code auth mode).
 * Run from repo root: bun packages/hf-bridge/scripts/smoke-plan.ts
 */
import { planEffects } from "../src/author";

const segments = [
	{ start: 0, end: 4.2, text: "Hey everyone, welcome back to the channel, I'm Dan from FrameCut." },
	{ start: 4.2, end: 9.8, text: "Today I'm going to show you how we cut our render times by 87 percent." },
	{ start: 9.8, end: 15.1, text: "First, let's talk about what was slowing everything down." },
	{ start: 15.1, end: 22.4, text: "The old pipeline re-encoded every clip three times before export." },
	{ start: 22.4, end: 28.0, text: "Quick tip: always check your codec settings before you blame the hardware." },
	{ start: 28.0, end: 34.5, text: "Now, part two: the fix. We moved everything to a single-pass renderer." },
	{ start: 34.5, end: 41.0, text: "That one change took exports from twelve minutes down to ninety seconds." },
];

console.log("Planning effects via claude-code...");
const started = Date.now();
const plan = await planEffects({
	segments,
	totalDurationSec: 41,
	auth: { mode: "claude-code" },
});
console.log(`OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(plan, null, 2));
