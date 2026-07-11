/**
 * Golden-footage eval runner (EV3). Feeds fixture transcripts through the
 * Director's PRODUCTION detector modules and scores the proposals against
 * ground truth derived from Dan's own finished edits. Zero LLM tokens, no
 * footage ever leaves the machine — fixtures are word-level transcripts.
 *
 *   cd apps/web
 *   bun scripts/director-eval.ts [fixtures-dir]   # default eval-fixtures/
 *   bun scripts/director-eval.ts --selftest       # synthetic end-to-end run
 *   bun scripts/director-eval.ts --json [dir]     # machine-readable output
 *
 * Fixture format (one .json per raw/final pair):
 *   {
 *     "name": "tutorial-2026-07-01",
 *     "rawWords":   [{ "text": "so", "start": 0.0, "end": 0.28 }, ...],
 *     "finalWords": [{ ... }],
 *     "rawSegments": [{ "text": "...", "start": 0, "end": 4.2 }]   // optional
 *   }
 * rawWords = transcript of the unedited footage; finalWords = transcript of
 * the exported final edit. Segments improve take-clustering; when absent they
 * are derived from word gaps and sentence punctuation.
 *
 *   bun scripts/director-eval.ts --llm [dir]      # FULL pipeline (detectors + 3 LLM passes)
 *   bun scripts/director-eval.ts --llm --runs 3   # 3 live passes, mean/spread of the headline numbers
 *   bun scripts/director-eval.ts --llm --auth api-key   # ANTHROPIC_API_KEY instead of claude-code
 *
 * Scope note: WITHOUT --llm this measures the DETERMINISTIC layers only. WITH
 * --llm it runs the app's OWN `buildDirectorProposals` module (the same code the
 * editor runs), with the three LLM passes called node-side via the eval adapter.
 *
 * FIDELITY CHECKLIST (R2) — every input to the shared pipeline in --llm mode:
 *   words, segments, features, envelope, clipSpans, elements, assets, totalSec
 *                          → SUPPLIED from the fixture (real audio-derived signals).
 *   llm (plan/redundancy/context) → LIVE via the hf-bridge planners + eval adapter.
 *   gaps: []               → STUBBED: VAD is config-gated off; fixtures carry no VAD
 *                            gaps (dead-air layer is out of scope for this eval).
 *   config.vadEnabled false → STUBBED: same reason.
 *   frames: [] / visionEnabled false → STUBBED: no fixture frames (vision-pass eval
 *                            is deferred follow-up work).
 *   taste: undefined       → STUBBED: measure the neutral planner, not a learned note.
 *   fps: 30                → STUBBED: fixtures are file-time; fps only sets sub-frame
 *                            cut floors, not the segment-level LLM cuts under test.
 */
import fs from "node:fs";
import path from "node:path";
import { alignTranscripts } from "@/features/ai-generate/director/eval/align";
import {
	formatScorecard,
	scoreCutProposals,
	scoreDual,
	type DualScorecard,
	type ProposedCutSpan,
	type Scorecard,
} from "@/features/ai-generate/director/eval/score";
import { detectDuplicateWordCuts } from "@/features/ai-generate/director/duplicate-words";
import { detectFillerCuts } from "@/features/ai-generate/director/filler-words";
import { buildTakeClusters } from "@/features/ai-generate/director/take-clusters";
import { detectRedundancyCuts } from "@/features/ai-generate/director/redundancy";
import { buildDirectorProposals } from "@/features/ai-generate/director/build-director-proposals";
import {
	createEvalLlmAdapter,
	resolveClaudeAuth,
	verifyClaudeCli,
} from "@/features/ai-generate/director/eval/llm-adapter";
import type { DirectorEvalFixture } from "@/features/ai-generate/director/eval/fixture-types";
import type { TranscriptionWord } from "@/transcription/types";

/** The eval consumes the shared fixture shape; the U3 audio fields (features,
 * envelope, clipSpans, elements, assets) are present on regenerated fixtures and
 * feed the `--llm` path (U5). The detector-only path needs only the transcripts. */
type Fixture = DirectorEvalFixture;

/** Derive sentence-ish segments from words when the fixture has none:
 * split on speech gaps > 0.6s or terminal punctuation. */
function deriveSegments(
	words: TranscriptionWord[],
): { text: string; start: number; end: number }[] {
	const segments: { text: string; start: number; end: number }[] = [];
	let start = 0;
	for (let i = 0; i < words.length; i++) {
		const gapAfter =
			i + 1 < words.length ? words[i + 1].start - words[i].end : Infinity;
		const terminal = /[.!?]$/.test(words[i].text.trim());
		if (gapAfter > 0.6 || terminal || i === words.length - 1) {
			segments.push({
				text: words
					.slice(start, i + 1)
					.map((w) => w.text)
					.join(" "),
				start: words[start].start,
				end: words[i].end,
			});
			start = i + 1;
		}
	}
	return segments;
}

/** Run the deterministic detector suite exactly as the Director wires it. */
function detectorProposals(fixture: Fixture): ProposedCutSpan[] {
	const words = fixture.rawWords;
	const segments = fixture.rawSegments ?? deriveSegments(words);

	const ops = [
		...detectDuplicateWordCuts({ words }),
		...detectFillerCuts({ words }),
		...detectRedundancyCuts({
			clusters: buildTakeClusters({
				assetTranscripts: [
					{
						assetId: "timeline",
						// Fixtures are timeline-relative, so source time == timeline time.
						segments: segments.map((s) => ({
							...s,
							sourceStartSec: s.start,
						})),
					},
				],
				features: [],
			}),
		}).ops,
	];

	return ops
		.filter((op) => op.op === "cut" || op.op === "take_select")
		.map((op) => ({
			startSec: op.startSec,
			endSec: op.endSec,
			source: op.category ?? op.op,
		}));
}

function runFixture(fixture: Fixture): {
	scorecard: Scorecard;
	proposalsBySource: Record<string, number>;
	substitutionWords: number;
	finalOnlyWords: number;
	movedWords: number;
} {
	const alignment = alignTranscripts({
		rawWords: fixture.rawWords,
		finalWords: fixture.finalWords,
	});
	const proposals = detectorProposals(fixture);
	const proposalsBySource: Record<string, number> = {};
	for (const p of proposals) {
		const key = p.source ?? "unknown";
		proposalsBySource[key] = (proposalsBySource[key] ?? 0) + 1;
	}
	return {
		scorecard: scoreCutProposals({
			rawWords: fixture.rawWords,
			truthCutSpans: alignment.truthCutSpans,
			proposedSpans: proposals,
		}),
		proposalsBySource,
		substitutionWords: alignment.substitutionWords,
		finalOnlyWords: alignment.finalOnlyWords,
		movedWords: alignment.movedWords,
	};
}

/** Throw an actionable "regenerate" error when a fixture predates the U3 audio
 * enrichment (an old transcript-only fixture can't drive the LLM pipeline). */
function requireAudioFields(fixture: DirectorEvalFixture): void {
	const missing: string[] = [];
	if (!fixture.rawSegments?.length) missing.push("rawSegments");
	if (!fixture.features?.length) missing.push("features");
	if (!fixture.envelope?.length) missing.push("envelope");
	if (!fixture.clipSpans?.length) missing.push("clipSpans");
	if (!fixture.elements?.length) missing.push("elements");
	if (!fixture.assets?.length) missing.push("assets");
	if (fixture.totalSec == null) missing.push("totalSec");
	if (missing.length > 0) {
		throw new Error(
			`Fixture "${fixture.name}" is missing --llm fields (${missing.join(", ")}). It predates the audio-feature enrichment — regenerate it:\n` +
				`  bun scripts/director-eval-prepare.ts --raw-dir "<clips folder>" --final "<final.mp4>" --name ${fixture.name}`,
		);
	}
}

/** Assemble the full `buildDirectorProposals` input from a fixture + adapter.
 * The stubbed inputs (gaps/frames/taste/fps/config) are documented in the header
 * fidelity checklist. */
function llmProposalInput(
	fixture: DirectorEvalFixture,
	adapter: ReturnType<typeof createEvalLlmAdapter>,
) {
	return {
		words: fixture.rawWords as TranscriptionWord[],
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
		llm: adapter,
	};
}

const fmtSources = (bySource: Record<string, number>): string =>
	Object.entries(bySource)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}:${v}`)
		.join("  ") || "(none)";

/** mean ± spread (max-min) over a sample. */
function meanSpread(xs: number[]): { mean: number; spread: number } {
	if (xs.length === 0) return { mean: 0, spread: 0 };
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	return { mean, spread: Math.max(...xs) - Math.min(...xs) };
}

function printLlmFixture(
	name: string,
	runs: DualScorecard[],
	movedWords: number,
): void {
	const first = runs[0];
	console.log(formatScorecard(`${name} — AUTO (one-click apply)`, first.auto));
	console.log(`proposals by source    ${fmtSources(first.autoBySource)}`);
	console.log("");
	console.log(formatScorecard(`${name} — OFFERED (all review rows)`, first.offered));
	console.log(`proposals by source    ${fmtSources(first.offeredBySource)}`);
	if (movedWords > 0) {
		console.log(`moved (reordered)      ${movedWords} words (excluded from truth cuts)`);
	}
	if (runs.length > 1) {
		const pctMS = (xs: number[]) => {
			const { mean, spread } = meanSpread(xs);
			return `${(mean * 100).toFixed(1)}% (spread ${(spread * 100).toFixed(1)}pp)`;
		};
		const numMS = (xs: number[]) => {
			const { mean, spread } = meanSpread(xs);
			return `${mean.toFixed(1)} (spread ${spread})`;
		};
		console.log(`\n-- variance across ${runs.length} live runs --`);
		console.log(`auto cut recall        ${pctMS(runs.map((r) => r.auto.cutRecall))}`);
		console.log(`auto essential lost    ${numMS(runs.map((r) => r.auto.essentialWordsLost))}`);
		console.log(`offered cut recall     ${pctMS(runs.map((r) => r.offered.cutRecall))}`);
		console.log(`offered essential lost ${numMS(runs.map((r) => r.offered.essentialWordsLost))}`);
	}
	console.log("");
}

/** FULL-pipeline mode (R1/R6): run `buildDirectorProposals` — the app's own
 * module — with the live LLM passes, and score both the auto and offered sets.
 * `--runs N` runs N live passes (each cached under its index) for variance. */
async function runLlmMode({
	fixtures,
	runs,
	authMode,
	wantJson,
}: {
	fixtures: Fixture[];
	runs: number;
	authMode: "claude-code" | "api-key";
	wantJson: boolean;
}): Promise<void> {
	const auth = resolveClaudeAuth({
		mode: authMode,
		apiKey: process.env.ANTHROPIC_API_KEY,
	});
	if (auth.mode === "claude-code") verifyClaudeCli();

	const jsonOut: unknown[] = [];
	for (const fixture of fixtures) {
		requireAudioFields(fixture);
		// Ground truth is deterministic — align once, reuse across the live runs.
		const alignment = alignTranscripts({
			rawWords: fixture.rawWords as TranscriptionWord[],
			finalWords: fixture.finalWords as TranscriptionWord[],
		});
		const runResults: DualScorecard[] = [];
		for (let runIndex = 0; runIndex < runs; runIndex++) {
			if (runs > 1) {
				console.error(`  [${fixture.name}] live run ${runIndex + 1}/${runs}...`);
			}
			const adapter = createEvalLlmAdapter({ auth, runIndex });
			const { operations } = await buildDirectorProposals(
				llmProposalInput(fixture, adapter),
			);
			runResults.push(
				scoreDual({
					rawWords: fixture.rawWords as TranscriptionWord[],
					truthCutSpans: alignment.truthCutSpans,
					operations,
				}),
			);
		}
		if (wantJson) {
			jsonOut.push({
				name: fixture.name,
				movedWords: alignment.movedWords,
				substitutionWords: alignment.substitutionWords,
				finalOnlyWords: alignment.finalOnlyWords,
				runs: runResults,
			});
		} else {
			printLlmFixture(fixture.name, runResults, alignment.movedWords);
		}
	}
	if (wantJson) console.log(JSON.stringify(jsonOut, null, 2));
}

function selftestFixture(): Fixture {
	const mk = (text: string): TranscriptionWord[] =>
		text
			.split(/\s+/)
			.filter(Boolean)
			.map((w, i) => ({
				text: w,
				start: i * 0.3,
				end: i * 0.3 + 0.28,
			}));
	return {
		name: "selftest (synthetic)",
		rawWords: mk(
			"okay um lets deploy this project to production. " +
				"wait that broke. lets deploy this project to production properly. " +
				"and now we are gonna verify the the logs together.",
		),
		finalWords: mk(
			"okay lets deploy this project to production properly. " +
				"and now we are going to verify the logs together.",
		),
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const has = (f: string) => args.includes(f);
	const val = (flag: string, dflt: string): string => {
		const i = args.indexOf(flag);
		return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
	};
	const wantJson = has("--json");
	const selftest = has("--selftest");
	const wantLlm = has("--llm");
	const runs = Math.max(1, Number(val("--runs", "1")) || 1);
	const authMode: "claude-code" | "api-key" =
		val("--auth", "claude-code") === "api-key" ? "api-key" : "claude-code";
	// Positional dir = first non-flag arg that isn't a flag's value (--runs 3 etc).
	const flagValues = new Set([val("--runs", ""), val("--auth", "")].filter(Boolean));
	const dirArg = args.find((a) => !a.startsWith("--") && !flagValues.has(a));

	const fixtures: Fixture[] = [];
	if (selftest) {
		fixtures.push(selftestFixture());
	} else {
		const dir = path.resolve(dirArg ?? "eval-fixtures");
		if (!fs.existsSync(dir)) {
			console.error(
				`No fixtures at ${dir}. Drop {name, rawWords, finalWords} JSON files there (see header comment), or run with --selftest.`,
			);
			process.exit(2);
		}
		for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			const parsed = JSON.parse(
				fs.readFileSync(path.join(dir, file), "utf8"),
			) as DirectorEvalFixture;
			fixtures.push({ ...parsed, name: parsed.name ?? file });
		}
		if (fixtures.length === 0) {
			console.error(`No .json fixtures found in ${dir}.`);
			process.exit(2);
		}
	}

	// FULL-pipeline mode (R1): the app's own module + live LLM passes. --selftest
	// stays detector-only (no tokens), so it can run in CI without auth.
	if (wantLlm && !selftest) {
		await runLlmMode({ fixtures, runs, authMode, wantJson });
		return;
	}

	const results = fixtures.map((f) => ({ name: f.name, ...runFixture(f) }));

	if (wantJson) {
		console.log(JSON.stringify(results, null, 2));
		return;
	}

	for (const r of results) {
		console.log(formatScorecard(r.name, r.scorecard));
		const sources = Object.entries(r.proposalsBySource)
			.map(([k, v]) => `${k}:${v}`)
			.join("  ");
		console.log(`proposals by source    ${sources || "(none)"}`);
		if (r.substitutionWords > 0 || r.finalOnlyWords > 0 || r.movedWords > 0) {
			console.log(
				`transcript noise       ${r.substitutionWords} substituted, ${r.finalOnlyWords} final-only (ignored), ${r.movedWords} moved (reordered, not cut)`,
			);
		}
		console.log("");
	}

	if (results.length > 1) {
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		console.log(`=== aggregate (${results.length} fixtures) ===`);
		console.log(
			`mean cut recall  ${(mean(results.map((r) => r.scorecard.cutRecall)) * 100).toFixed(1)}%`,
		);
		console.log(
			`total essential words lost  ${results.reduce((a, r) => a + r.scorecard.essentialWordsLost, 0)}`,
		);
	}
	console.log(
		"note: deterministic detectors only — run with --llm to measure the full pipeline (detectors + the three LLM passes).",
	);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
