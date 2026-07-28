/**
 * Diagnostic replay (LIVE-TEST-ISSUES item 1): run the Director pipeline on the
 * join-the-group clip with the EXACT transcript the 2026-07-17 live run used
 * (extracted from the app's transcript cache in Dan's browser) and dump every
 * op with silence-map annotations, so each unnecessary cut can be attributed
 * to the pass that produced it. Investigation tooling, not product code.
 *
 *   cd apps/web && bun scripts/diag-join-the-group.ts
 *
 * Mirrors the live config: retake ON, structural ON, verify auto-on, clamp on,
 * keeper "last", no compression, no VAD, no vision, neutral taste.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDirectorProposals } from "@/features/ai-generate/director/build-director-proposals";
import {
	createEvalLlmAdapter,
	resolveClaudeAuth,
	verifyClaudeCli,
} from "@/features/ai-generate/director/eval/llm-adapter";
import { buildFixtureAudioFeatures } from "@/features/ai-generate/director/eval/fixture-types";
import type { TranscriptionWord } from "@/transcription/types";

const SRC =
	"C:/Users/danom/Videos/0714 Building an app for app testers/2026-07-14 13-46-45_join the group.mp4";
const TOTAL_SEC = 83.866667;
const TICKS_PER_SECOND = 120_000;
const OUT =
	"C:/Users/danom/AppData/Local/Temp/claude/D--Claude-framecut/1012aa19-2948-4e7d-985d-0df9433f32f4/scratchpad/diag-join-ops.json";

/* Words from the cached live-run transcript (Groq whisper-large-v3-turbo),
 * project fbe8b9d9, clip 1. The final "Thank"/"you." pair is a Whisper
 * hallucination over the 57.7-81.9s dead air; "you." is clamped to clip end. */
const W: [string, number, number][] = [
	["I", 0.92, 1.02], ["need", 1.02, 1.24], ["app", 1.24, 1.54], ["testers", 1.54, 2.1],
	["and", 2.1, 2.58], ["that", 2.58, 3.08], ["is", 3.08, 3.24], ["an", 3.24, 3.36],
	["issue.", 3.36, 3.68], ["We", 3.18, 3.8], ["are", 3.8, 3.96], ["going", 3.96, 4.12],
	["to", 4.12, 4.22], ["build", 4.22, 4.46], ["it", 4.46, 4.64], ["and", 4.64, 4.8],
	["I'm", 4.8, 4.96], ["going", 4.96, 5.02], ["to", 5.02, 5.12], ["walk", 5.12, 5.36],
	["you", 5.36, 5.56], ["through", 5.56, 5.74], ["that", 5.74, 5.98], ["process", 5.98, 6.52],
	["first,", 6.52, 7.82], ["because", 7.82, 8.08], ["if", 8.08, 8.3], ["you're", 7.82, 8.42],
	["building", 8.42, 8.66], ["an", 8.66, 8.88], ["app", 8.88, 9.02], ["on", 9.02, 9.26],
	["Android,", 9.26, 9.98], ["you", 9.98, 10.22], ["need", 10.22, 10.4], ["at", 10.4, 10.56],
	["least", 10.56, 10.96], ["12", 10.96, 11.64], ["unique", 11.64, 12.48], ["users", 12.48, 12.98],
	["to", 12.98, 13.62], ["install", 13.62, 14], ["the", 14, 14.24], ["app", 14.24, 14.46],
	["and", 14.06, 14.68], ["have", 14.68, 15], ["the", 15, 15.28], ["app", 15.28, 15.46],
	["on", 15.46, 15.72], ["their", 15.72, 15.86], ["phone", 15.86, 16.16], ["for", 16.16, 16.98],
	["two", 16.98, 17.3], ["weeks.", 17.3, 17.86], ["So", 17.66, 18.4], ["we're", 18.4, 18.6],
	["going", 18.6, 18.64], ["to", 18.64, 18.76], ["solve", 18.76, 19.14], ["that", 19.14, 19.56],
	["by", 19.56, 20.14], ["creating", 20.14, 20.8], ["a", 20.8, 21.06], ["solution", 21.06, 21.5],
	["to", 21.5, 21.76], ["it.", 21.76, 22.08], ["And", 21.82, 22.76], ["before", 22.76, 23.36],
	["we", 23.36, 23.6], ["do", 23.6, 23.78], ["that,", 23.78, 24.3], ["we", 24.3, 24.54],
	["are", 24.54, 24.68], ["going", 24.68, 24.88], ["to", 24.88, 25.1], ["showcase", 25.1, 25.66],
	["the", 25.66, 26.14], ["process", 26.14, 26.92], ["because", 26.92, 27.74], ["I", 27.74, 28.26],
	["need", 28.26, 28.68], ["your", 28.68, 29.14], ["help,", 29.14, 29.46], ["too.", 29.46, 29.94],
	["So", 30.04, 30.14], ["I'm", 30.14, 30.24], ["going", 30.24, 30.3], ["to", 30.3, 30.4],
	["leave", 30.4, 30.56], ["a", 30.56, 30.66], ["link", 30.66, 30.84], ["in", 30.84, 31.02],
	["the", 31.02, 31.12], ["description.", 31.12, 31.5], ["Prends,", 31.92, 32.38],
	["testers,", 32.38, 32.86], ["it's", 32.86, 33.06], ["going", 33.06, 33.16], ["to", 33.16, 33.26],
	["go", 33.26, 33.4], ["to", 33.4, 33.52], ["this", 33.52, 33.7], ["site.", 33.7, 34.08],
	["You", 34.46, 34.58], ["have", 34.58, 34.76], ["to", 34.76, 34.92], ["join", 34.92, 35.3],
	["the", 35.3, 35.5], ["group.", 35.5, 35.72], ["It's", 36.16, 36.38], ["going", 36.38, 36.42],
	["to", 36.42, 36.54], ["show", 36.54, 36.72], ["your", 36.72, 36.88], ["display", 36.88, 37.24],
	["name,", 37.24, 38], ["subscription,", 38, 38.9], ["email,", 38.9, 39.46], ["and", 39.46, 40.2],
	["that's", 40.2, 41.22], ["fine.", 41.22, 41.42], ["I", 42.34, 42.48], ["don't", 42.48, 42.62],
	["think", 42.62, 42.76], ["you", 42.76, 42.86], ["even", 42.86, 43.02], ["have", 43.02, 43.14],
	["to", 43.14, 43.28], ["link", 43.28, 43.52], ["to", 43.52, 43.76], ["your", 43.76, 43.88],
	["Google", 43.88, 44.16], ["accounts.", 44.16, 44.72], ["So", 48.16, 48.3], ["I'm", 48.3, 48.42],
	["going", 48.42, 48.5], ["to", 48.5, 48.58], ["leave", 48.58, 48.8], ["a", 48.8, 48.96],
	["link", 48.96, 49.1], ["in", 49.1, 49.28], ["the", 49.28, 49.38], ["description,", 49.38, 49.78],
	["and", 49.78, 50.08], ["all", 50.08, 50.2], ["you", 50.2, 50.32], ["do", 50.32, 50.42],
	["is", 50.42, 50.62], ["hit", 50.62, 50.74], ["join", 50.74, 51.04], ["group.", 51.04, 51.3],
	["You", 51.88, 52.02], ["do", 52.02, 52.12], ["not", 52.12, 52.34], ["have", 52.34, 52.58],
	["to", 52.58, 52.72], ["link", 52.72, 52.94], ["to", 52.94, 53.14], ["your", 53.14, 53.28],
	["Google", 53.28, 53.58], ["profile.", 53.58, 54.08], ["You", 54.6, 54.72], ["do", 54.72, 54.84],
	["not", 54.84, 55.06], ["have", 55.06, 55.28], ["to", 55.28, 55.44], ["subscribe,", 55.44, 55.84],
	["and", 55.84, 56.32], ["you", 56.32, 56.44], ["can", 56.44, 56.6], ["join", 56.6, 56.86],
	["the", 56.86, 57.06], ["group", 57.06, 57.26], ["still.", 57.26, 57.84],
	["Thank", 59.92, 69.2], ["you.", 69.2, 83.866],
];

/* Segments verbatim from the cache (leading spaces preserved, as the app got
 * them). The final "Thank you." segment is the hallucination, clamped. */
const S: [string, number, number][] = [
	[" I need app testers and that is an issue.", 0.96, 3.68],
	[" We are going to build it and I'm going to walk you through that process first, because if", 3.68, 8.32],
	[" you're building an app on Android, you need at least 12 unique users to install the app", 8.32, 14.56],
	[" and have the app on their phone for two weeks.", 14.56, 18.16],
	[" So we're going to solve that by creating a solution to it.", 18.16, 22.32],
	[" And before we do that, we are going to showcase the process because I need your help, too.", 22.32, 29.92],
	[" So I'm going to leave a link in the description.", 29.92, 31.58],
	[" Prends, testers, it's going to go to this site.", 32, 34.06],
	[" You have to join the group.", 34.4, 35.8],
	[" It's going to show your display name, subscription, email, and that's fine.", 36.12, 41.44],
	[" I don't think you even have to link to your Google accounts.", 42.08, 44.72],
	[" So I'm going to leave a link in the description, and all you do is hit join group.", 47.9, 51.36],
	[" You do not have to link to your Google profile.", 51.7, 54.2],
	[" You do not have to subscribe, and you can join the group still.", 54.5, 57.64],
	[" Thank you.", 59.92, 83.866],
];

/* ffmpeg silencedetect ground truth (noise=-35dB, d=0.35s), seconds. */
const SILENCE: [number, number][] = [
	[0, 0.959], [6.658, 7.076], [7.427, 7.865], [11.703, 12.13], [16.219, 16.796],
	[17.905, 18.258], [19.65, 20.025], [21.891, 22.381], [26.252, 26.602],
	[34.028, 34.386], [35.732, 36.201], [39.411, 39.998], [40.522, 41.021],
	[41.428, 42.395], [44.758, 48.194], [51.342, 51.926], [57.679, 81.905],
	[82.975, 83.819],
];

function extractPcm(): Float32Array {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-join-"));
	const out = path.join(tmp, "audio.f32le");
	const r = spawnSync("ffmpeg", ["-y", "-i", SRC, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", out], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString().slice(-400)}`);
	const buf = fs.readFileSync(out);
	const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4));
	return new Float32Array(aligned);
}

function silenceAt(t: number): [number, number] | null {
	for (const [s, e] of SILENCE) if (t >= s - 0.02 && t <= e + 0.02) return [s, e];
	return null;
}

function annotateBoundary(t: number): { inSilence: boolean; silence?: [number, number]; residualBefore?: number; residualAfter?: number } {
	const hit = silenceAt(t);
	if (!hit) return { inSilence: false };
	/* residual = silence left OUTSIDE the cut on each side of this boundary,
	 * i.e. dead air that stays in the kept clip. */
	return { inSilence: true, silence: hit, residualBefore: +(t - hit[0]).toFixed(2), residualAfter: +(hit[1] - t).toFixed(2) };
}

async function main(): Promise<void> {
	const words = W.map(([text, start, end]) => ({ text, start, end })) as TranscriptionWord[];
	const segments = S.map(([text, start, end]) => ({ text, start, end }));
	const samples = extractPcm();
	const { envelope, features } = buildFixtureAudioFeatures({ samples, sampleRate: 16000, segments, round: false });

	const auth = resolveClaudeAuth({ mode: "claude-code", apiKey: process.env.ANTHROPIC_API_KEY });
	if (auth.mode === "claude-code") verifyClaudeCli();
	const adapter = createEvalLlmAdapter({
		auth,
		runIndex: 0,
		enableRetake: true,
		enableStructural: true,
		enableVerify: true,
	});

	const name = "2026-07-14 13-46-45_join the group.mp4";
	const { operations } = await buildDirectorProposals({
		words,
		segments,
		features,
		envelope,
		gaps: [],
		clipSpans: [{ startSec: 0, endSec: TOTAL_SEC }],
		fps: 30,
		elements: [{ id: "clip-1", mediaId: name, startTime: 0, duration: Math.round(TOTAL_SEC * TICKS_PER_SECOND), trimStart: 0 }],
		assets: [{ id: name, name, durationSec: TOTAL_SEC }],
		frames: [],
		taste: undefined,
		totalSec: TOTAL_SEC,
		config: { vadEnabled: false, visionEnabled: false },
		keeperPolicy: "last",
		llm: adapter,
	});

	const wordsIn = (a: number, b: number) =>
		words.filter((w) => w.start < b && w.end > a).map((w) => w.text).join(" ");

	const dump = operations.map((op) => ({
		id: op.id,
		op: op.op,
		category: op.category ?? null,
		reason: (op as { reason?: string }).reason ?? null,
		defaultAccept: op.defaultAccept !== false,
		startSec: +op.startSec.toFixed(2),
		endSec: +op.endSec.toFixed(2),
		durSec: +(op.endSec - op.startSec).toFixed(2),
		text: wordsIn(op.startSec, op.endSec).slice(0, 140),
		startBoundary: annotateBoundary(op.startSec),
		endBoundary: annotateBoundary(op.endSec),
	}));

	/* Resulting keep fragments if the AUTO rows applied as-is (what Dan saw). */
	const autoCuts = operations
		.filter((o) => (o.op === "cut" || o.op === "take_select") && o.defaultAccept !== false)
		.map((o) => ({ s: o.startSec, e: o.endSec }))
		.sort((a, b) => a.s - b.s);
	const merged: { s: number; e: number }[] = [];
	for (const c of autoCuts) {
		const last = merged[merged.length - 1];
		if (last && c.s <= last.e) last.e = Math.max(last.e, c.e);
		else merged.push({ ...c });
	}
	const fragments: { startSec: number; endSec: number; durSec: number; text: string }[] = [];
	let cursor = 0;
	for (const c of merged) {
		if (c.s > cursor) fragments.push({ startSec: +cursor.toFixed(2), endSec: +c.s.toFixed(2), durSec: +(c.s - cursor).toFixed(2), text: wordsIn(cursor, c.s).slice(0, 80) });
		cursor = Math.max(cursor, c.e);
	}
	if (cursor < TOTAL_SEC) fragments.push({ startSec: +cursor.toFixed(2), endSec: TOTAL_SEC, durSec: +(TOTAL_SEC - cursor).toFixed(2), text: wordsIn(cursor, TOTAL_SEC).slice(0, 80) });

	const result = {
		config: "retake+structural+verify on, clamp on, keeper last, no compression/vad/vision, neutral taste",
		opCount: operations.length,
		autoRemovalCount: autoCuts.length,
		offeredRemovalCount: operations.filter((o) => (o.op === "cut" || o.op === "take_select") && o.defaultAccept === false).length,
		autoCutSeconds: +merged.reduce((acc, c) => acc + (c.e - c.s), 0).toFixed(1),
		keepFragmentsAfterAuto: fragments,
		operations: dump,
	};
	fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
	console.log(JSON.stringify({ opCount: result.opCount, auto: result.autoRemovalCount, offered: result.offeredRemovalCount, autoCutSeconds: result.autoCutSeconds, fragments: fragments.length, out: OUT }, null, 1));

	/* ---- Round-6 U7 assertion mode: mechanize R1-R3 and exit non-zero. ---- */
	const { guardHallucinations } = await import(
		"@/features/ai-generate/director/hallucination-guard"
	);
	const guard = guardHallucinations({
		words: words as { text: string; start: number; end: number }[],
		segments,
		envelope,
		windowSec: 0.05,
	});
	const cleanWords = guard.cleanWords;
	const failures: string[] = [];
	const GAP_CATEGORIES = new Set(["pacing", "deadair", "noise"]);
	const removals = operations.filter((o) => o.op === "cut" || o.op === "take_select");

	// R1a: no gap-derived AUTO removal contains a clean word midpoint.
	for (const op of removals) {
		if (op.defaultAccept === false) continue;
		if (!GAP_CATEGORIES.has(op.category ?? "")) continue;
		for (const w of cleanWords) {
			const mid = (w.start + w.end) / 2;
			if (mid >= op.startSec && mid < op.endSec) {
				failures.push(`R1a: gap-derived AUTO ${op.id} [${op.startSec.toFixed(2)}-${op.endSec.toFixed(2)}] contains word "${w.text}"`);
			}
		}
	}
	// R1b: no removal boundary of ANY family strictly inside a clean word.
	// Whisper emits OVERLAPPING word timestamps, so a boundary sitting exactly
	// on SOME clean word's edge counts as word-boundary-placed even when
	// another overlapping word technically contains it.
	const atWordEdge = (t: number) =>
		cleanWords.some((w) => Math.abs(t - w.start) <= 0.02 || Math.abs(t - w.end) <= 0.02);
	for (const op of removals) {
		for (const w of cleanWords) {
			for (const [label, t] of [["start", op.startSec], ["end", op.endSec]] as const) {
				if (t > w.start + 0.01 && t < w.end - 0.01 && !atWordEdge(t)) {
					failures.push(`R1b: ${op.id} ${label} ${t.toFixed(2)} inside word "${w.text}" [${w.start}-${w.end}]`);
				}
			}
		}
	}
	// R2: every AUTO removal boundary is silence-placed (kept-side residual <= 0.2s)
	// or word-adjacent (within 0.3s of a clean word edge).
	const wordAdjacent = (t: number) =>
		cleanWords.some((w) => Math.abs(t - w.end) <= 0.3 || Math.abs(t - w.start) <= 0.3);
	for (const op of removals) {
		if (op.defaultAccept === false) continue;
		for (const [label, t, keptSide] of [
			["start", op.startSec, "before"],
			["end", op.endSec, "after"],
		] as const) {
			if (t <= 0.01 || t >= TOTAL_SEC - 0.01) continue; // timeline edge is fine
			// A boundary within one envelope window of a silence-interval EDGE is
			// flush against the speech that ends/starts the silence: residual 0.
			const nearSilenceEdge = SILENCE.some(
				([s, e]) => Math.abs(t - s) <= 0.1 || Math.abs(t - e) <= 0.1,
			);
			const sil = silenceAt(t);
			const residual =
				sil === null ? Infinity : keptSide === "before" ? t - sil[0] : sil[1] - t;
			if (residual > 0.21 && !wordAdjacent(t) && !nearSilenceEdge) {
				failures.push(`R2: ${op.id} ${label} ${t.toFixed(2)} leaves ${residual === Infinity ? "speech-interior" : residual.toFixed(2) + "s"} residual and is not word-adjacent`);
			}
		}
	}
	// R3: the dead-air tail and the 3.4s pause are cut AUTO.
	const autoCovers = (a: number, b: number) =>
		merged.some((c) => c.s <= a && c.e >= b);
	if (!autoCovers(58.5, 81.0)) failures.push("R3: the 24s dead-air tail [58.5-81.0] is not covered by an AUTO cut");
	if (!autoCovers(45.2, 47.8)) failures.push("R3: the 3.4s pause [45.2-47.8] is not covered by an AUTO cut");
	// Sanity band on merged-union AUTO seconds (catastrophe catch, generous).
	if (result.autoCutSeconds < 20 || result.autoCutSeconds > 45) {
		failures.push(`band: merged AUTO cut seconds ${result.autoCutSeconds} outside [20, 45]`);
	}

	if (failures.length > 0) {
		console.error(`\nASSERTIONS FAILED (${failures.length}):`);
		for (const f of failures) console.error("  - " + f);
		process.exit(1);
	}
	console.log("\nASSERTIONS PASSED (R1a, R1b, R2, R3, band)");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
