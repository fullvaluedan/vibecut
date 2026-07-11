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
 * Scope note: this measures the DETERMINISTIC layers (duplicates, fillers,
 * take-cluster redundancy). The LLM passes (segment cuts, redundancy pass)
 * are not wired yet — a scorecard gap between detector-only recall and Dan's
 * real cuts is exactly the measurement of what the LLM layer must carry.
 */
import fs from "node:fs";
import path from "node:path";
import { alignTranscripts } from "@/features/ai-generate/director/eval/align";
import {
	formatScorecard,
	scoreCutProposals,
	type ProposedCutSpan,
	type Scorecard,
} from "@/features/ai-generate/director/eval/score";
import { detectDuplicateWordCuts } from "@/features/ai-generate/director/duplicate-words";
import { detectFillerCuts } from "@/features/ai-generate/director/filler-words";
import { buildTakeClusters } from "@/features/ai-generate/director/take-clusters";
import { detectRedundancyCuts } from "@/features/ai-generate/director/redundancy";
import type { TranscriptionWord } from "@/transcription/types";

interface Fixture {
	name: string;
	rawWords: TranscriptionWord[];
	finalWords: TranscriptionWord[];
	rawSegments?: { text: string; start: number; end: number }[];
}

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
	};
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

function main(): void {
	const args = process.argv.slice(2);
	const wantJson = args.includes("--json");
	const selftest = args.includes("--selftest");
	const dirArg = args.find((a) => !a.startsWith("--"));

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
			) as Fixture;
			fixtures.push({ ...parsed, name: parsed.name ?? file });
		}
		if (fixtures.length === 0) {
			console.error(`No .json fixtures found in ${dir}.`);
			process.exit(2);
		}
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
		if (r.substitutionWords > 0 || r.finalOnlyWords > 0) {
			console.log(
				`transcript noise       ${r.substitutionWords} substituted, ${r.finalOnlyWords} final-only (ignored)`,
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
		"note: deterministic detectors only — the LLM passes are not wired into the eval yet, so the recall gap above is what the LLM layer must carry.",
	);
}

main();
