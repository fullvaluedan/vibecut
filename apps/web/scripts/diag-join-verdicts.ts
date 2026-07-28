/**
 * Per-fragment final-read harness (round 12 U2 / round 13). The AUTO/OFFERED
 * eval CANNOT see the final read: join rows are opt-in by construction, so
 * promoting one to checked moves no AUTO metric and no OFFERED metric. This
 * harness is the instrument that CAN see it.
 *
 *   cd apps/web && bun scripts/diag-join-verdicts.ts
 *   cd apps/web && bun scripts/diag-join-verdicts.ts --runs 3   # per-run tables
 *
 * What it does, per fixture:
 *  1. Runs the app's own `buildDirectorProposals` with retake + structural +
 *     verify ON at runIndex 0, mirroring the SHIPPED app (not the eval's old
 *     opt-in defaults).
 *  2. Finds every `join`-category op in the final operation list and keeps the
 *     WORD-BEARING ones (a wordless sliver is AUTO by construction and carries
 *     no verdict to grade).
 *  3. Labels each fragment against Dan's own final via `alignTranscripts`
 *     `rawKept`: a fragment whose words are mostly absent from the final is one
 *     Dan CUT, otherwise one he KEPT.
 *  4. Crosses that label against the POST-VERIFY `defaultAccept` state
 *     (`true` = the final read swallowed it, `false` = left offered) and prints
 *     a per-fragment line, the confusion matrix, and recall/precision.
 *
 * PRECISION is the number not to lose: a wrong swallow destroys dialog Dan kept.
 * Recall is the lever. Keep this script - every future final-read round needs it.
 *
 * Diagnostic tooling, not product code. Reuses the eval's disk cache, so a
 * re-run at an unchanged VERIFY_PROMPT_VERSION costs zero tokens.
 *
 * WATCHDOG TRAP, learned in round 13 and worth the paragraph: a verify call that
 * exceeds the adapter watchdog fail-opens, so EVERY fragment on that fixture
 * reads "left offered" - indistinguishable from a model that voted keep on all
 * of them, and it silently cost this round two wrong conclusions. how-to-edit is
 * the fixture that trips it. Always run with a generous budget:
 *
 *   EVAL_LLM_TIMEOUT_MS=2400000 bun scripts/diag-join-verdicts.ts
 *
 * and if a fixture reports every fragment offered, confirm a verify response was
 * actually cached for it (`ls -t .eval-cache/verify-*.json`) before believing it.
 */
import fs from "node:fs";
import path from "node:path";
import {
	buildDirectorProposals,
	formatRemovalHint,
} from "@/features/ai-generate/director/build-director-proposals";
import { isMidpointContained } from "@/features/ai-generate/director/cut-utils";
import { alignTranscripts } from "@/features/ai-generate/director/eval/align";
import {
	createEvalLlmAdapter,
	resolveClaudeAuth,
	verifyClaudeCli,
} from "@/features/ai-generate/director/eval/llm-adapter";
import type { DirectorEvalFixture } from "@/features/ai-generate/director/eval/fixture-types";
import type { TranscriptionWord } from "@/transcription/types";

/** One graded fragment: what the join stranded, what Dan did, what we did. */
interface GradedFragment {
	fixture: string;
	text: string;
	startSec: number;
	endSec: number;
	/** True when Dan's final does NOT contain the fragment (he cut it). */
	danCut: boolean;
	/** True when the final read promoted the row to checked (a swallow). */
	swallowed: boolean;
}

/** Dan's label for a fragment: he CUT it when most of its words are missing
 * from his final (`rawKept[i] === false`). A tie counts as kept - the harness
 * must never invent a cut Dan did not make. */
function fragmentDanCut(
	wordIdx: readonly number[],
	rawKept: readonly boolean[],
): boolean {
	let cut = 0;
	for (const i of wordIdx) if (rawKept[i] === false) cut++;
	return cut > wordIdx.length - cut;
}

/** Grade one fixture at one run index. */
async function gradeFixture({
	fixture,
	runIndex,
	auth,
}: {
	fixture: DirectorEvalFixture;
	runIndex: number;
	auth: ReturnType<typeof resolveClaudeAuth>;
}): Promise<GradedFragment[]> {
	const rawWords = fixture.rawWords as TranscriptionWord[];
	const alignment = alignTranscripts({
		rawWords,
		finalWords: fixture.finalWords as TranscriptionWord[],
	});
	const cutRatio =
		alignment.rawKept.length > 0
			? alignment.rawKept.filter((kept) => !kept).length / alignment.rawKept.length
			: 0;
	// Mirrors the shipped app: both recall passes on, verify on. The structural
	// removal hint comes from the fixture's own truth ratio, exactly as
	// `director-eval.ts --structural` derives it, so the cache is shared.
	const adapter = createEvalLlmAdapter({
		auth,
		runIndex,
		enableRetake: true,
		enableStructural: true,
		enableVerify: true,
		structuralRemovalHint: formatRemovalHint(cutRatio),
	});
	const { operations } = await buildDirectorProposals({
		words: rawWords,
		segments: fixture.rawSegments!,
		features: fixture.features!,
		envelope: fixture.envelope!,
		gaps: [],
		clipSpans: fixture.clipSpans!,
		fps: 30,
		elements: fixture.elements!,
		assets: fixture.assets!,
		frames: [],
		taste: undefined,
		totalSec: fixture.totalSec!,
		config: { vadEnabled: false, visionEnabled: false },
		keeperPolicy: "last",
		llm: adapter,
	});

	const graded: GradedFragment[] = [];
	for (const op of operations) {
		if (op.category !== "join") continue;
		const wordIdx: number[] = [];
		for (let i = 0; i < rawWords.length; i++) {
			const w = rawWords[i];
			if (
				isMidpointContained({
					spanStart: w.start,
					spanEnd: w.end,
					containerStart: op.startSec,
					containerEnd: op.endSec,
				})
			)
				wordIdx.push(i);
		}
		// A wordless sliver auto-swallows by construction and carries no verdict.
		if (wordIdx.length === 0) continue;
		graded.push({
			fixture: fixture.name,
			text: wordIdx.map((i) => rawWords[i].text.trim()).join(" "),
			startSec: op.startSec,
			endSec: op.endSec,
			danCut: fragmentDanCut(wordIdx, alignment.rawKept),
			swallowed: op.defaultAccept !== false,
		});
	}
	return graded;
}

/** Print the per-fragment lines, the confusion matrix, and the summary. */
function report(graded: readonly GradedFragment[], label: string): void {
	console.log(`\n=== per-fragment final-read verdicts (${label}) ===`);
	for (const g of graded) {
		const mark = g.danCut === g.swallowed ? "  ok " : " MISS";
		const dan = g.danCut ? "Dan CUT " : "Dan KEPT";
		const ours = g.swallowed ? "swallowed" : "offered  ";
		console.log(
			`${mark} ${g.fixture.padEnd(12)} ${dan}  ${ours}  ${g.startSec.toFixed(1)}s  "${g.text}"`,
		);
	}
	const cutSwallowed = graded.filter((g) => g.danCut && g.swallowed).length;
	const cutOffered = graded.filter((g) => g.danCut && !g.swallowed).length;
	const keptSwallowed = graded.filter((g) => !g.danCut && g.swallowed).length;
	const keptOffered = graded.filter((g) => !g.danCut && !g.swallowed).length;
	const danCutTotal = cutSwallowed + cutOffered;
	const swallowTotal = cutSwallowed + keptSwallowed;
	const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "n/a");
	console.log("");
	console.log("                        swallowed   left offered");
	console.log(
		`Dan CUT the fragment (${String(danCutTotal).padStart(2)})   ${String(cutSwallowed).padStart(6)}   ${String(cutOffered).padStart(12)}`,
	);
	console.log(
		`Dan KEPT the fragment (${String(keptSwallowed + keptOffered).padStart(2)})  ${String(keptSwallowed).padStart(6)}   ${String(keptOffered).padStart(12)}`,
	);
	console.log("");
	console.log(
		`recall     ${cutSwallowed}/${danCutTotal} (${pct(cutSwallowed, danCutTotal)}) of the fragments Dan cut were swallowed`,
	);
	console.log(
		`precision  ${cutSwallowed}/${swallowTotal} (${pct(cutSwallowed, swallowTotal)}) of our swallows were fragments Dan cut  [${keptSwallowed} wrong swallow(s)]`,
	);
	console.log(`fragments  ${graded.length} word-bearing join rows graded\n`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const val = (flag: string, dflt: string): string => {
		const i = args.indexOf(flag);
		return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
	};
	const runs = Math.max(1, Number(val("--runs", "1")) || 1);
	const authMode: "claude-code" | "api-key" =
		val("--auth", "claude-code") === "api-key" ? "api-key" : "claude-code";
	const dir = path.resolve(val("--fixtures", "eval-fixtures"));
	if (!fs.existsSync(dir)) {
		console.error(`No fixtures at ${dir}.`);
		process.exit(2);
	}
	const auth = resolveClaudeAuth({
		mode: authMode,
		apiKey: process.env.ANTHROPIC_API_KEY,
	});
	if (auth.mode === "claude-code") verifyClaudeCli();

	const fixtures: DirectorEvalFixture[] = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((file) => {
			const parsed = JSON.parse(
				fs.readFileSync(path.join(dir, file), "utf8"),
			) as DirectorEvalFixture;
			return { ...parsed, name: parsed.name ?? file };
		});

	for (let runIndex = 0; runIndex < runs; runIndex++) {
		const graded: GradedFragment[] = [];
		for (const fixture of fixtures) {
			console.error(`  [${fixture.name}] run ${runIndex + 1}/${runs}...`);
			graded.push(...(await gradeFixture({ fixture, runIndex, auth })));
		}
		report(graded, `runIndex ${runIndex}`);
	}
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
