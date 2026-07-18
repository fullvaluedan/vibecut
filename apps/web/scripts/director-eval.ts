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
 *   bun scripts/director-eval.ts --llm --runs 3   # 3 independent live draws per fixture: mean/std/
 *                                                  # min/max of the headline numbers, per fixture and
 *                                                  # pooled across fixtures (round-5 variance lesson)
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
import { formatAggregateTable } from "@/features/ai-generate/director/eval/aggregate";
import {
	attributeEssentialWordsLost,
	formatByCategoryLine,
	formatTopOffendingOps,
	type EssentialLossAttribution,
} from "@/features/ai-generate/director/eval/attribution";
import { detectDuplicateWordCuts } from "@/features/ai-generate/director/duplicate-words";
import { detectFillerCuts } from "@/features/ai-generate/director/filler-words";
import { buildTakeClusters, type KeeperPolicy } from "@/features/ai-generate/director/take-clusters";
import { detectRedundancyCuts } from "@/features/ai-generate/director/redundancy";
import {
	buildDirectorProposals,
	formatRemovalHint,
} from "@/features/ai-generate/director/build-director-proposals";
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
	keepRatio: number;
	cutRatio: number;
} {
	const alignment = alignTranscripts({
		rawWords: fixture.rawWords,
		finalWords: fixture.finalWords,
	});
	const cutRatio = truthCutRatio(alignment.rawKept);
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
			noiseSpans: [...alignment.substitutionSpans, ...alignment.movedSpans],
		}),
		proposalsBySource,
		substitutionWords: alignment.substitutionWords,
		finalOnlyWords: alignment.finalOnlyWords,
		movedWords: alignment.movedWords,
		keepRatio: 1 - cutRatio,
		cutRatio,
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
	options: {
		keeperPolicy: KeeperPolicy;
		compressionTarget?: number;
		/** `--no-clamp` sets this to Infinity so U2's clamp passes every plan op through. */
		clampOversizedSpanSec?: number;
	},
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
		// A/B knobs (U2/U3/U5): keeper policy + the compression target. Both flow into
		// the shared module unchanged; compressionTarget also changes the plan cache key.
		keeperPolicy: options.keeperPolicy,
		...(options.compressionTarget !== undefined
			? { compressionTarget: options.compressionTarget }
			: {}),
		...(options.clampOversizedSpanSec !== undefined
			? { clampOversizedSpanSec: options.clampOversizedSpanSec }
			: {}),
		llm: adapter,
	};
}

/** The fraction of raw words Dan actually removed in the finished cut — the fixture's
 * own truth ratio (KTD4). `rawKept[i]` is false for a cut word; this is cut/total. */
function truthCutRatio(rawKept: readonly boolean[]): number {
	if (rawKept.length === 0) return 0;
	const cut = rawKept.filter((kept) => !kept).length;
	return cut / rawKept.length;
}

const fmtSources = (bySource: Record<string, number>): string =>
	Object.entries(bySource)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}:${v}`)
		.join("  ") || "(none)";

/** Print the essLost-by-category line and top-offending-ops block for one
 * section (AUTO or OFFERED), but only when that section actually lost
 * essential words: an untouched fixture prints no attribution lines at all,
 * so every existing report stays byte-identical. */
function printAttribution(
	essentialWordsLost: number,
	attribution: EssentialLossAttribution,
): void {
	if (essentialWordsLost <= 0) return;
	const categoryLine = formatByCategoryLine(attribution);
	if (categoryLine) console.log(categoryLine);
	const opLines = formatTopOffendingOps(attribution);
	if (opLines) for (const line of opLines) console.log(line);
}

function printLlmFixture(
	name: string,
	runs: DualScorecard[],
	noise: { movedWords: number; substitutionWords: number; rawWordCount: number },
	/** First run's essLost attribution (auto + offered), for the "which ops
	 * destroyed which kept words" lines. Mirrors `runs[0]`: attribution
	 * printing is scoped to the same single draw the rest of the section
	 * details (falseCutSpans, missedSpans) already report against. */
	attribution: { auto: EssentialLossAttribution; offered: EssentialLossAttribution },
): void {
	const first = runs[0];
	console.log(formatScorecard(`${name} — AUTO (one-click apply)`, first.auto));
	console.log(`proposals by source    ${fmtSources(first.autoBySource)}`);
	printAttribution(first.auto.essentialWordsLost, attribution.auto);
	console.log("");
	console.log(formatScorecard(`${name} — OFFERED (all review rows)`, first.offered));
	console.log(`proposals by source    ${fmtSources(first.offeredBySource)}`);
	printAttribution(first.offered.essentialWordsLost, attribution.offered);
	// Noise share: the label-noise words the adjusted match rate excludes, so the
	// raw-vs-adjusted gap is legible next to the headline number.
	const noiseWords = noise.substitutionWords + noise.movedWords;
	const noisePct =
		noise.rawWordCount > 0 ? (noiseWords / noise.rawWordCount) * 100 : 0;
	console.log(
		`noise share            ${noiseWords} words (${noisePct.toFixed(1)}% of raw): ${noise.substitutionWords} substitution + ${noise.movedWords} moved`,
	);
	if (noise.movedWords > 0) {
		console.log(`moved (reordered)      ${noise.movedWords} words (excluded from truth cuts)`);
	}
	if (runs.length > 1) {
		// The variance round (round-5 lesson): a single draw is too noisy to tune
		// thresholds against, so print mean/std/min/max for the headline metrics
		// across the N live runs of THIS fixture.
		console.log("");
		console.log(formatAggregateTable(name, runs));
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
	keeperPolicy,
	compression,
	retake,
	structural,
	verify,
	clamp,
}: {
	fixtures: Fixture[];
	runs: number;
	authMode: "claude-code" | "api-key";
	wantJson: boolean;
	keeperPolicy: KeeperPolicy;
	/** When true, compute each fixture's compression target from its own truth ratio. */
	compression: boolean;
	/** U3 retake-hunt pass, opt-in via `--retake` (mirrors the in-app default OFF per the
	 * round-3 verdict: match-neutral-at-best, R10 keeps it off by default). */
	retake: boolean;
	/** U2 structural-drop pass, opt-in via `--structural` (default OFF, mirroring the app).
	 * When on, the pass's removalHint is derived from each fixture's own truth ratio so the
	 * lever is measured (KTD4). */
	structural: boolean;
	/** U2 verify sub-pass. Follows the recall passes (on whenever retake OR structural is on)
	 * with a `--no-verify` override; it fires exactly when recall candidates exist (R5). */
	verify: boolean;
	/** U2 clamp on (default) or off (`--no-clamp`, threshold → Infinity), for the U3-only combo. */
	clamp: boolean;
}): Promise<void> {
	const auth = resolveClaudeAuth({
		mode: authMode,
		apiKey: process.env.ANTHROPIC_API_KEY,
	});
	if (auth.mode === "claude-code") verifyClaudeCli();

	const jsonOut: unknown[] = [];
	// Pooled across every fixture's runs (only populated when runs > 1), for the
	// "total across fixtures" block the variance round asks for.
	const allRuns: DualScorecard[] = [];
	for (const fixture of fixtures) {
		requireAudioFields(fixture);
		// Ground truth is deterministic — align once, reuse across the live runs.
		const alignment = alignTranscripts({
			rawWords: fixture.rawWords as TranscriptionWord[],
			finalWords: fixture.finalWords as TranscriptionWord[],
		});
		const cutRatio = truthCutRatio(alignment.rawKept);
		const compressionTarget = compression ? cutRatio : undefined;
		// Structural removal-share hint (U2/KTD4): when `--structural` is on, derive the
		// creator's removal share from the fixture's own truth ratio and feed it to the
		// structural pass (the SAME sentence the in-app path builds from compressionTarget)
		// so the removalHint lever is exercised without enabling the compression contract.
		const structuralRemovalHint = structural ? formatRemovalHint(cutRatio) : undefined;
		console.error(
			`  [${fixture.name}] keep-ratio ${((1 - cutRatio) * 100).toFixed(1)}% ` +
				`(removes ${(cutRatio * 100).toFixed(1)}%)  keeper=${keeperPolicy}  ` +
				`compression=${compression ? `${(cutRatio * 100).toFixed(1)}%` : "off"}  ` +
				`retake=${retake ? "on" : "off"}  structural=${structural ? "on" : "off"}  ` +
				`verify=${verify ? "on" : "off"}  clamp=${clamp ? "on" : "off"}`,
		);
		const runResults: DualScorecard[] = [];
		// Per-run essLost attribution (auto + offered), parallel to `runResults`:
		// which op(s) destroyed which kept words, for the hermes-class "stable-high
		// AUTO essLost" hunt (ADDENDUM 8) that the plain scorecard can't answer.
		const runAttributions: {
			auto: EssentialLossAttribution;
			offered: EssentialLossAttribution;
		}[] = [];
		for (let runIndex = 0; runIndex < runs; runIndex++) {
			if (runs > 1) {
				console.error(`  [${fixture.name}] live run ${runIndex + 1}/${runs}...`);
			}
			const adapter = createEvalLlmAdapter({
				auth,
				runIndex,
				enableRetake: retake,
				enableStructural: structural,
				enableVerify: verify,
				structuralRemovalHint,
			});
			const { operations } = await buildDirectorProposals(
				llmProposalInput(fixture, adapter, {
					keeperPolicy,
					compressionTarget,
					// `--no-clamp`: threshold → Infinity so every plan op passes U2 untouched.
					...(clamp ? {} : { clampOversizedSpanSec: Infinity }),
				}),
			);
			runResults.push(
				scoreDual({
					rawWords: fixture.rawWords as TranscriptionWord[],
					truthCutSpans: alignment.truthCutSpans,
					operations,
					noiseSpans: [
						...alignment.substitutionSpans,
						...alignment.movedSpans,
					],
				}),
			);
			runAttributions.push({
				auto: attributeEssentialWordsLost({
					rawWords: fixture.rawWords as TranscriptionWord[],
					truthCutSpans: alignment.truthCutSpans,
					operations,
					mode: "auto",
				}),
				offered: attributeEssentialWordsLost({
					rawWords: fixture.rawWords as TranscriptionWord[],
					truthCutSpans: alignment.truthCutSpans,
					operations,
					mode: "offered",
				}),
			});
		}
		if (runs > 1) allRuns.push(...runResults);
		if (wantJson) {
			jsonOut.push({
				name: fixture.name,
				movedWords: alignment.movedWords,
				substitutionWords: alignment.substitutionWords,
				finalOnlyWords: alignment.finalOnlyWords,
				runs: runResults,
				// New field (round-11 attribution lever): per-run essLost attribution,
				// index-parallel to `runs`. Existing fields above are untouched.
				essLostAttribution: runAttributions,
			});
		} else {
			printLlmFixture(
				fixture.name,
				runResults,
				{
					movedWords: alignment.movedWords,
					substitutionWords: alignment.substitutionWords,
					rawWordCount: fixture.rawWords.length,
				},
				runAttributions[0],
			);
		}
	}
	// Total across fixtures (round-5 lesson, variance round): only meaningful once
	// there is more than one live draw per fixture, and purely additive: `--runs 1`
	// (the default) never reaches this branch, so today's output is untouched.
	if (runs > 1 && allRuns.length > 0) {
		if (wantJson) {
			jsonOut.push({ name: "__all_fixtures__", totalAcrossFixtures: true, runs: allRuns });
		} else {
			console.log(formatAggregateTable("total across fixtures", allRuns));
			console.log("");
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
	// A/B knobs (U2/U3/U5): `--keeper quality` flips the take-keeper policy; `--compression`
	// derives each fixture's target from its own truth ratio. Both cache independently.
	const keeperPolicy: KeeperPolicy = val("--keeper", "last") === "quality" ? "quality" : "last";
	const compression = has("--compression");
	// U3 A/B knobs (defaults mirror the app: retake OFF per the round-3 verdict, clamp ON):
	// `--retake` enables the retake-hunt pass (`--no-retake` still honored for the off
	// state); `--no-clamp` disables U2's clamp (its oversized threshold → Infinity, every
	// plan op passes through) for the U3-only combo.
	const retake = has("--retake") && !has("--no-retake");
	// U2 structural-drop pass, opt-in via `--structural` (default OFF, mirroring the app).
	const structural = has("--structural");
	// U2 verify sub-pass: follows the recall passes (on whenever retake OR structural is on)
	// with a `--no-verify` override, so it fires exactly when recall candidates exist (R5).
	const verify = (retake || structural) && !has("--no-verify");
	const clamp = !has("--no-clamp");
	// Positional dir = first non-flag arg that isn't a flag's value (--runs 3 etc).
	const flagValues = new Set(
		[val("--runs", ""), val("--auth", ""), val("--keeper", "")].filter(Boolean),
	);
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
		await runLlmMode({
			fixtures,
			runs,
			authMode,
			wantJson,
			keeperPolicy,
			compression,
			retake,
			structural,
			verify,
			clamp,
		});
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
		console.log(
			`keep ratio             ${(r.keepRatio * 100).toFixed(1)}% (Dan removed ${(r.cutRatio * 100).toFixed(1)}% of raw words)`,
		);
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
