/**
 * TEMP redundancy-quality probe: runs the REAL planRedundancy on a crafted
 * transcript that contains the exact failure modes reported (opening near-verbatim
 * retake, reworded restatement, filler retake) + one genuinely-distinct line that
 * must NOT be grouped. Shows what the LLM catches + at what confidence, so we can
 * tell whether the pass is too conservative vs a wiring/threshold problem.
 *   bun packages/hf-bridge/scripts/redundancy-smoke.ts
 */
import { planRedundancy, type RedundancyLine } from "../src/index.ts";

const lines: RedundancyLine[] = [
	{ lineId: "L0", startSec: 0, endSec: 3, text: "Hey everyone, welcome back to the channel.", loudnessRelative: 0.5, wpm: 150 },
	{ lineId: "L1", startSec: 3, endSec: 6.5, text: "Hey everyone, welcome back to the channel, so today.", loudnessRelative: 0.7, wpm: 150 }, // near-verbatim OPENING retake of L0
	{ lineId: "L2", startSec: 7, endSec: 11, text: "Today I'm going to show you three tips for editing faster.", loudnessRelative: 0.6, wpm: 160 },
	{ lineId: "L3", startSec: 11, endSec: 16, text: "So in this video I'll walk you through three ways to edit more quickly.", loudnessRelative: 0.65, wpm: 158 }, // REWORDED restatement of L2
	{ lineId: "L4", startSec: 16, endSec: 19, text: "The first tip is to cut on action.", loudnessRelative: 0.6, wpm: 150 },
	{ lineId: "L5", startSec: 19, endSec: 23, text: "Uh, so, first tip, cut on the action, right.", loudnessRelative: 0.4, wpm: 130, fillerCandidate: true }, // filler RETAKE of L4
	{ lineId: "L6", startSec: 23, endSec: 28, text: "That keeps the pacing tight and the viewer engaged.", loudnessRelative: 0.6, wpm: 155 }, // DISTINCT — must NOT group
	{ lineId: "L7", startSec: 28, endSec: 31, text: "The second tip is to remove your filler words.", loudnessRelative: 0.6, wpm: 150 }, // DISTINCT
];

const { plan, usage } = await planRedundancy({ lines, auth: { mode: "claude-code" as const } });
console.log("=== groups returned ===");
if (plan.groups.length === 0) console.log("(none — the LLM grouped NOTHING)");
for (const g of plan.groups) {
	console.log(
		`conf=${g.confidence.toFixed(2)} keep=${g.keeperLineId} members=[${g.members.map((m) => m.lineId).join(",")}] :: ${g.reason}`,
	);
}
console.log("\n=== expected: {L0,L1} opening retake, {L2,L3} reworded, {L4,L5} filler retake; L6/L7 NOT grouped ===");
console.log(`tokens: in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"}`);
// floor reminder
console.log("NOTE: redundancy-apply.ts drops groups with confidence < 0.7 (DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR).");
