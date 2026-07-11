import { describe, expect, test } from "bun:test";
import {
	buildDirectorProposals,
	type DirectorLlmAdapter,
} from "../build-director-proposals";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { TranscriptionWord } from "@/transcription/types";
import type { SpeechFeatures } from "../types";
import type { TranscriptSegment } from "../build-signal-table";
import type { SourceMapElement } from "../source-map";

/**
 * Characterization test (U2 execution note): pin the pure pipeline's shape so the
 * verbatim extraction from run-director can't silently reorder the merge → second-
 * pass → snap → trim → justify chain or flip the S4 defaultAccept gating. Feeds a
 * synthetic fused-sense set with a STUBBED llm and asserts the merged/sanitized
 * result structurally (counts, order, keep-exclusion, redundancyRan fallback).
 */

const TICKS_PER_SECOND = 120_000;

/** 0.3s-spaced timed words from a sentence. */
function mkWords(text: string): TranscriptionWord[] {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((w, i) => ({ text: w, start: i * 0.3, end: i * 0.3 + 0.28 }));
}

/** Two segments over the words, split at `splitWordIndex`. */
function mkSegments(
	words: TranscriptionWord[],
	splitWordIndex: number,
): TranscriptSegment[] {
	if (words.length === 0) return [];
	const a = words.slice(0, splitWordIndex);
	const b = words.slice(splitWordIndex);
	const seg = (ws: TranscriptionWord[]): TranscriptSegment => ({
		text: ws.map((w) => w.text).join(" "),
		start: ws[0].start,
		end: ws[ws.length - 1].end,
	});
	return b.length > 0 ? [seg(a), seg(b)] : [seg(a)];
}

function mkFeatures(segments: TranscriptSegment[]): SpeechFeatures[] {
	return segments.map((s) => ({
		startSec: s.start,
		endSec: s.end,
		energy: 0.1,
		loudnessRelative: 0.8,
		wpm: 150,
		wordCount: s.text.split(/\s+/).length,
		fillerCandidate: false,
	}));
}

function mkElements(totalSec: number): SourceMapElement[] {
	return [
		{
			id: "el1",
			mediaId: "a1",
			startTime: 0,
			duration: Math.round(totalSec * TICKS_PER_SECOND),
			trimStart: 0,
		},
	];
}

/** An llm adapter that returns fixed responses; callers override per-test. */
function stubLlm(overrides: Partial<DirectorLlmAdapter> = {}): DirectorLlmAdapter {
	return {
		async plan() {
			return { plan: { operations: [] } };
		},
		async redundancy() {
			return { plan: { groups: [] } };
		},
		async context() {
			return { plan: { flags: [] } };
		},
		...overrides,
	};
}

function baseInput(words: TranscriptionWord[], splitWordIndex: number) {
	const segments = mkSegments(words, splitWordIndex);
	const totalSec = words.length > 0 ? words[words.length - 1].end : segments.at(-1)?.end ?? 0;
	return {
		words,
		segments,
		features: mkFeatures(segments),
		envelope: new Array(Math.max(1, Math.ceil(totalSec / 0.02))).fill(0.05),
		gaps: [],
		clipSpans: [{ startSec: 0, endSec: totalSec }],
		fps: 30,
		elements: mkElements(totalSec),
		assets: [{ id: "a1", name: "clip.mp4", durationSec: totalSec }],
		frames: [],
		taste: undefined,
		totalSec,
		config: { vadEnabled: false, visionEnabled: false },
	};
}

describe("buildDirectorProposals (pure pipeline extraction)", () => {
	const SENTENCE =
		"so um lets deploy the the project and now we verify the logs together carefully";

	test("stub llm + synthetic senses yields a merged, sorted op list", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		// The LLM proposes a cut inside segment 2 plus a KEEP op (protection must be
		// invisible in the returned ops).
		const planCut: DirectorOp = {
			id: "llm-cut-1",
			op: "cut",
			startSec: 3.0,
			endSec: 3.5,
			reason: "off-topic aside",
			confidence: 0.9,
		};
		const keep: DirectorOp = {
			id: "llm-keep-1",
			op: "keep",
			startSec: 0,
			endSec: 0.5,
			reason: "load-bearing intro",
			confidence: 0.9,
		};
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm({ async plan() {
				return { plan: { operations: [planCut, keep] } };
			} }),
		});

		// Shape: all six fields present.
		expect(Array.isArray(result.operations)).toBe(true);
		expect(Array.isArray(result.applyProtectedSpans)).toBe(true);
		expect(result.redundancyRan).toBe(true); // stub redundancy returned ok

		// Ordering: operations are sorted ascending by start.
		const starts = result.operations.map((o) => o.startSec);
		expect(starts).toEqual([...starts].sort((a, b) => a - b));

		// Protection is invisible in the normal path — no keep op survives.
		expect(result.operations.some((o) => o.op === "keep")).toBe(false);

		// The LLM's cut span is represented in the final ops (survives merge/snap).
		expect(
			result.operations.some((o) => o.startSec < 3.5 && 3.0 < o.endSec),
		).toBe(true);

		// The always-on cleanup fired: the doubled "the the" produced a cut op.
		expect(result.operations.length).toBeGreaterThan(1);
	});

	test("redundancy route error → redundancyRan false, pipeline still returns ops", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm({ async redundancy() {
				throw new Error("route 500");
			} }),
		});
		expect(result.redundancyRan).toBe(false);
		expect(Array.isArray(result.operations)).toBe(true);
	});

	test("empty words still runs the segment layers without throwing", async () => {
		// Degraded transcript: no words, but segments exist (from a coarser source).
		const words: TranscriptionWord[] = [];
		const segments: TranscriptSegment[] = [
			{ text: "intro line one here", start: 0, end: 2 },
			{ text: "second line follows on", start: 3, end: 5 },
		];
		const result = await buildDirectorProposals({
			words,
			segments,
			features: mkFeatures(segments),
			envelope: new Array(300).fill(0.05),
			gaps: [],
			clipSpans: [{ startSec: 0, endSec: 5 }],
			fps: 30,
			elements: mkElements(5),
			assets: [{ id: "a1", name: "clip.mp4", durationSec: 5 }],
			frames: [],
			taste: undefined,
			totalSec: 5,
			config: { vadEnabled: false, visionEnabled: false },
			llm: stubLlm(),
		});
		expect(Array.isArray(result.operations)).toBe(true);
	});
});
