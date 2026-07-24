import { NextRequest, NextResponse } from "next/server";
import {
	planVerify,
	type RedundancyLine,
	type RetakeWord,
	type VerifyCandidate,
	type VerifyJoinFragment,
	type VerifyHarmCandidate,
} from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Parse the wire `candidates` array into typed `VerifyCandidate[]`, dropping any
 * malformed entry. Returns `null` when absent/not-an-array (a bad request). The
 * optional tighten anchors (`startWord`/`endWord`/`startLineId`/`endLineId`) are
 * kept only when well-typed; a candidate missing them can still be kept/rejected,
 * just not tightened (matches `sanitizeVerifyPlan`'s degrade-to-keep contract).
 */
function parseCandidates(raw: unknown): VerifyCandidate[] | null {
	if (!Array.isArray(raw)) return null;
	const out: VerifyCandidate[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			(it.category === "retake" || it.category === "structural") &&
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec) &&
			typeof it.reason === "string" &&
			typeof it.confidence === "number" &&
			Number.isFinite(it.confidence) &&
			typeof it.coveredText === "string"
		) {
			out.push({
				category: it.category,
				startSec: it.startSec,
				endSec: it.endSec,
				reason: it.reason,
				confidence: it.confidence,
				coveredText: it.coveredText,
				...(typeof it.startWord === "number" && Number.isInteger(it.startWord)
					? { startWord: it.startWord }
					: {}),
				...(typeof it.endWord === "number" && Number.isInteger(it.endWord)
					? { endWord: it.endWord }
					: {}),
				...(typeof it.startLineId === "string" ? { startLineId: it.startLineId } : {}),
				...(typeof it.endLineId === "string" ? { endLineId: it.endLineId } : {}),
			});
		}
	}
	return out;
}

/**
 * Parse the wire `lines` array into typed `RedundancyLine[]`, dropping any malformed
 * entry. Returns `null` when absent/not-an-array (a bad request). Mirrors the
 * structural route's parser (same catalog shape).
 */
function parseLines(raw: unknown): RedundancyLine[] | null {
	if (!Array.isArray(raw)) return null;
	const out: RedundancyLine[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.lineId === "string" &&
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec) &&
			typeof it.text === "string"
		) {
			out.push({
				lineId: it.lineId,
				startSec: it.startSec,
				endSec: it.endSec,
				text: it.text,
				...(typeof it.clipName === "string" ? { clipName: it.clipName } : {}),
				...(typeof it.loudnessRelative === "number"
					? { loudnessRelative: it.loudnessRelative }
					: {}),
				...(typeof it.wpm === "number" ? { wpm: it.wpm } : {}),
				...(it.fillerCandidate === true ? { fillerCandidate: true } : {}),
			});
		}
	}
	return out;
}

/**
 * Parse the wire `words` array into typed `RetakeWord[]`, dropping any malformed
 * entry. Returns `null` when absent/not-an-array (a bad request). Mirrors the
 * retake route's parser (same word shape); the verify pass needs the full word
 * catalog to resolve a retake candidate's tighten (R2: without it, every retake
 * tighten silently degrades to keep).
 */
function parseWords(raw: unknown): RetakeWord[] | null {
	if (!Array.isArray(raw)) return null;
	const out: RetakeWord[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.text === "string" &&
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec)
		) {
			out.push({ text: it.text, startSec: it.startSec, endSec: it.endSec });
		}
	}
	return out;
}

/**
 * Parse the wire `joinFragments` array into typed `VerifyJoinFragment[]`, dropping
 * any malformed entry (round 12 U2). OPTIONAL on the wire: absent or not-an-array
 * degrades to an empty list rather than a 400 - the final read is an enhancement
 * on top of the damage review, never a reason to fail the pass.
 */
function parseJoinFragments(raw: unknown): VerifyJoinFragment[] {
	if (!Array.isArray(raw)) return [];
	const out: VerifyJoinFragment[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.id === "string" &&
			it.id.length > 0 &&
			typeof it.text === "string" &&
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec) &&
			typeof it.contextBefore === "string" &&
			typeof it.contextAfter === "string"
		) {
			out.push({
				id: it.id,
				text: it.text,
				startSec: it.startSec,
				endSec: it.endSec,
				contextBefore: it.contextBefore,
				contextAfter: it.contextAfter,
			});
		}
	}
	return out;
}

/**
 * Parse the wire `harmCandidates` array into typed `VerifyHarmCandidate[]`, dropping
 * any malformed entry (round 14 U2/P3). OPTIONAL on the wire, like `joinFragments`:
 * absent or not-an-array degrades to an empty list, so the harm/texture review is an
 * enhancement on top of the damage review, never a reason to fail the pass.
 */
function parseHarmCandidates(raw: unknown): VerifyHarmCandidate[] {
	if (!Array.isArray(raw)) return [];
	const out: VerifyHarmCandidate[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.id === "string" &&
			it.id.length > 0 &&
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec) &&
			typeof it.removedText === "string" &&
			typeof it.contextBefore === "string" &&
			typeof it.contextAfter === "string"
		) {
			out.push({
				id: it.id,
				startSec: it.startSec,
				endSec: it.endSec,
				removedText: it.removedText,
				contextBefore: it.contextBefore,
				contextAfter: it.contextAfter,
				texture: it.texture === true,
			});
		}
	}
	return out;
}

/**
 * The dedicated verify endpoint (U3): every recall-pass candidate (category
 * `retake`/`structural`) plus BOTH resolution catalogs (lines and words) in; a
 * sanitized, index-keyed `VerifyPlan` (keep/reject/tighten verdicts) + token usage
 * out. Mirrors the Director structural route in shape. The pass is fail-open end
 * to end (R4): a planner throw is caught here and reported as a degraded, empty
 * plan rather than a 500, so a flaky verify call never aborts the Director run;
 * the client-side adapter just receives zero verdicts and every candidate passes
 * through unverified.
 */
export async function POST(req: NextRequest) {
	const auth = resolveAiAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "Your AI connection isn't fully configured. Check Settings → AI." },
			{ status: 401 },
		);
	}

	const body = await req.json().catch(() => null);
	const candidates = parseCandidates(body?.candidates);
	if (!candidates) {
		return NextResponse.json({ error: "Invalid candidates" }, { status: 400 });
	}
	const lines = parseLines(body?.lines);
	if (!lines) {
		return NextResponse.json({ error: "Invalid lines" }, { status: 400 });
	}
	const words = parseWords(body?.words);
	if (!words) {
		return NextResponse.json({ error: "Invalid words" }, { status: 400 });
	}
	const taste = typeof body?.taste === "string" ? body.taste : undefined;
	// Final-read inputs (round 12 U2): both OPTIONAL on the wire. A missing or
	// malformed assembled transcript / fragment list degrades to the plain damage
	// review rather than a 400.
	const joinFragments = parseJoinFragments(body?.joinFragments);
	const assembledTranscript =
		typeof body?.assembledTranscript === "string"
			? body.assembledTranscript
			: undefined;
	// Harm/texture review inputs (round 14 U2/P3): OPTIONAL on the wire like the
	// final-read inputs above.
	const harmCandidates = parseHarmCandidates(body?.harmCandidates);

	try {
		const { plan, usage } = await planVerify({
			candidates,
			lines,
			words,
			taste,
			assembledTranscript,
			joinFragments,
			harmCandidates,
			auth,
		});
		return NextResponse.json({ plan, usage });
	} catch (e) {
		// Fail-open (R4): a planner error degrades to zero verdicts instead of failing
		// the whole Director run. Logged server-side only; the client sees a normal 200
		// with an empty plan, and every candidate passes through unverified (join rows
		// stay OFFERED).
		console.error("Verify planning failed:", e instanceof Error ? e.message : e);
		return NextResponse.json({
			plan: { verdicts: [], joinVerdicts: [], harmVerdicts: [] },
			usage: null,
			degraded: true,
		});
	}
}
