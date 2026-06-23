/**
 * Opt-in Director debug report (issue A investigation — paraphrased opening repeats).
 *
 * A paraphrased repeat near the start falls through every DETERMINISTIC layer by
 * design: take-clusters + segment-repeat need lexical similarity ≥ HIGH_SIMILAR
 * (near-verbatim), phrase-repeat needs a verbatim n-gram, and same-asset pairs
 * <3s apart are ineligible. So it lands on the LLM. To tune which layer should
 * catch it WITHOUT guessing thresholds blind, we need the real opening: the
 * segment text, the pairwise lexical similarity (how far below the 0.8 merge bar
 * is it?), and whether the LLM itself proposed a cut there.
 *
 * This builds that report as a string; `run-director` logs it to the console when
 * `window.__directorDebug` is set. Pure + wasm-free → bun-testable.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { HIGH_SIMILAR, similarity } from "./text-similarity";

/** Window from the start (seconds) the report inspects. */
export const DEFAULT_OPENING_SEC = 30;

interface DebugSegment {
	start: number;
	end: number;
	text: string;
}

const fmtOp = (op: DirectorOp): string =>
	`${op.op}/${op.category ?? "?"}[${op.startSec.toFixed(2)}-${op.endSec.toFixed(2)}]`;

/**
 * Build the opening-redundancy debug report: the first `openingSec` of segments,
 * their pairwise lexical similarity (flagging any pair that clears HIGH_SIMILAR),
 * the RAW LLM ops in that window, and the FINAL merged ops in that window. Reading
 * it answers the three handoff questions at once: how similar the two phrases are,
 * whether the LLM flagged the repeat, and whether anything survived to review.
 */
export function buildOpeningDebugReport({
	segments,
	planOps,
	operations,
	openingSec = DEFAULT_OPENING_SEC,
}: {
	segments: readonly DebugSegment[];
	planOps: readonly DirectorOp[];
	operations: readonly DirectorOp[];
	openingSec?: number;
}): string {
	const opening = segments.filter((s) => s.start < openingSec);
	const lines: string[] = [
		`[director-debug] opening ${opening.length} segment(s) in first ${openingSec}s:`,
	];
	opening.forEach((s, i) => {
		lines.push(`  #${i} ${s.start.toFixed(2)}-${s.end.toFixed(2)}s: ${JSON.stringify(s.text)}`);
	});

	lines.push(`[director-debug] pairwise lexical similarity (merge bar HIGH_SIMILAR=${HIGH_SIMILAR}):`);
	let anyPair = false;
	for (let i = 0; i < opening.length; i++) {
		for (let j = i + 1; j < opening.length; j++) {
			anyPair = true;
			const score = similarity({ a: opening[i].text, b: opening[j].text });
			const flag = score >= HIGH_SIMILAR ? "  <- clears bar (would cluster)" : "";
			lines.push(`  #${i}~#${j}: ${score.toFixed(3)}${flag}`);
		}
	}
	if (!anyPair) {
		lines.push("  (need ≥2 opening segments to compare)");
	}

	const inOpening = (op: DirectorOp): boolean => op.startSec < openingSec;
	const rawList = planOps.filter(inOpening).map(fmtOp).join(", ");
	const finalList = operations.filter(inOpening).map(fmtOp).join(", ");
	lines.push(`[director-debug] RAW LLM ops in opening: ${rawList || "(none — the LLM proposed no cut here)"}`);
	lines.push(`[director-debug] FINAL merged ops in opening: ${finalList || "(none)"}`);
	return lines.join("\n");
}
