import { describe, expect, test } from "bun:test";
import {
	buildDirectorProposals,
	type DirectorLlmAdapter,
	type DirectorRetakeRequest,
} from "../build-director-proposals";
import type { DirectorOp, RetakeCut, StructuralDrop } from "@framecut/hf-bridge";
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

/**
 * U3 retake-hunt wiring (R6/R10). The pass is OPTIONAL on the adapter, OFFERED-only,
 * and folded through the same mergeDetectedCuts flow as the other detectors.
 */
describe("buildDirectorProposals + retake pass (U3)", () => {
	const SENTENCE =
		"so um lets deploy the the project and now we verify the logs together carefully";
	const retakeStub = (cuts: RetakeCut[]) => ({
		async retake() {
			return { plan: { cuts } };
		},
	});

	test("an adapter WITHOUT retake matches one whose retake returns no cuts (unchanged)", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const noRetake = await buildDirectorProposals({ ...input, llm: stubLlm() });
		const emptyRetake = await buildDirectorProposals({
			...input,
			llm: stubLlm(retakeStub([])),
		});
		// The guarded pass contributes nothing when it returns no cuts, so the op list is
		// byte-identical to the pre-U3 (retake-method-absent) pipeline.
		expect(emptyRetake.operations).toEqual(noRetake.operations);
	});

	test("a retake candidate covering a protected keeper span is dropped by merge rule 1", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		// [3.0,3.5] is a clean region (no filler/duplicate detector cut lands there).
		const keep: DirectorOp = {
			id: "keep-1",
			op: "keep",
			startSec: 3.0,
			endSec: 3.5,
			reason: "load-bearing",
			confidence: 0.9,
		};
		const overKeeper: RetakeCut = { startSec: 3.0, endSec: 3.5, reason: "flub", confidence: 0.9 };

		const suppressed = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				async plan() {
					return { plan: { operations: [keep] } };
				},
				...retakeStub([overKeeper]),
			}),
		});
		// Suppression is visible + counted, not silent: the retake row is gone.
		expect(suppressed.operations.some((o) => o.category === "retake")).toBe(false);

		// Control: the SAME retake, with no keeper protecting it, survives, proving the
		// keeper (not some other layer) is what dropped it.
		const survives = await buildDirectorProposals({
			...input,
			llm: stubLlm(retakeStub([overKeeper])),
		});
		expect(survives.operations.some((o) => o.category === "retake")).toBe(true);
	});

	test("a retake overlapping an existing plan removal merges without double-cutting", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const planCut: DirectorOp = {
			id: "plan-cut",
			op: "cut",
			startSec: 3.0,
			endSec: 3.5,
			reason: "tangent",
			confidence: 0.9,
		};
		const inside: RetakeCut = { startSec: 3.1, endSec: 3.4, reason: "flub", confidence: 0.9 };
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				async plan() {
					return { plan: { operations: [planCut] } };
				},
				...retakeStub([inside]),
			}),
		});
		// The retake fell inside the plan removal → deduped away, never a second cut.
		expect(result.operations.some((o) => o.category === "retake")).toBe(false);
		// The plan removal itself still covers that region.
		expect(
			result.operations.some((o) => o.startSec < 3.5 && 3.0 < o.endSec),
		).toBe(true);
	});

	test("a retake in a clean region survives as an OFFERED (unchecked) row", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const clean: RetakeCut = { startSec: 3.0, endSec: 3.5, reason: "false start", confidence: 0.9 };
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm(retakeStub([clean])),
		});
		const retakeOps = result.operations.filter((o) => o.category === "retake");
		expect(retakeOps.length).toBeGreaterThan(0);
		// OFFERED-only: never auto-applied.
		expect(retakeOps.every((o) => o.defaultAccept === false)).toBe(true);
	});

	test("the retake pass receives the pipeline's removals as handledSpans", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		let seen: DirectorRetakeRequest | undefined;
		await buildDirectorProposals({
			...input,
			llm: stubLlm({
				async retake(req) {
					seen = req;
					return { plan: { cuts: [] } };
				},
			}),
		});
		expect(seen).toBeDefined();
		expect(seen!.words).toHaveLength(words.length);
		// The doubled "the the" (plus filler) guarantees at least one existing removal,
		// and every handled span is a real, positive-length removal span.
		expect(Array.isArray(seen!.handledSpans)).toBe(true);
		expect(seen!.handledSpans!.length).toBeGreaterThan(0);
		expect(seen!.handledSpans!.every((s) => s.endSec > s.startSec)).toBe(true);
		// No compressionTarget → no removal hint (generic exhaustive wording).
		expect(seen!.removalHint).toBeUndefined();
	});

	test("compressionTarget (existing input) derives the removalHint percentage", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		let seen: DirectorRetakeRequest | undefined;
		await buildDirectorProposals({
			...input,
			compressionTarget: 0.55,
			llm: stubLlm({
				async retake(req) {
					seen = req;
					return { plan: { cuts: [] } };
				},
			}),
		});
		expect(seen?.removalHint).toContain("55%");
	});
});

/**
 * U2 structural-drop wiring (R2/R4/R5/R10). The pass is OPTIONAL on the adapter,
 * OFFERED-only, and folded through the same trim + mergeDetectedCuts flow as the retake
 * pass (after it), with the `structural` id namespace so pieces never collide.
 */
describe("buildDirectorProposals + structural pass (U2)", () => {
	const SENTENCE =
		"so um lets deploy the the project and now we verify the logs together carefully";
	const structuralStub = (drops: StructuralDrop[]) => ({
		async structural() {
			return { plan: { drops } };
		},
	});

	test("an adapter WITHOUT structural matches one whose structural returns no drops (byte-identical)", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const noStructural = await buildDirectorProposals({ ...input, llm: stubLlm() });
		const emptyStructural = await buildDirectorProposals({
			...input,
			llm: stubLlm(structuralStub([])),
		});
		// The guarded pass contributes nothing when it returns no drops, so the op list is
		// byte-identical to the structural-method-absent pipeline.
		expect(emptyStructural.operations).toEqual(noStructural.operations);
	});

	test("a structural candidate in a clean region survives as an OFFERED (unchecked) row with category structural", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const clean: StructuralDrop = {
			startSec: 3.0,
			endSec: 3.5,
			reason: "off-throughline tangent",
			confidence: 0.9,
		};
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm(structuralStub([clean])),
		});
		const structuralOps = result.operations.filter((o) => o.category === "structural");
		expect(structuralOps.length).toBeGreaterThan(0);
		// OFFERED-only: never auto-applied.
		expect(structuralOps.every((o) => o.defaultAccept === false)).toBe(true);
	});

	test("the structural pass receives the POST-RETAKE removals as handledSpans", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const retakeCut: RetakeCut = { startSec: 3.0, endSec: 3.5, reason: "flub", confidence: 0.9 };
		let seen: { handledSpans?: { startSec: number; endSec: number }[] } | undefined;
		await buildDirectorProposals({
			...input,
			llm: stubLlm({
				async retake() {
					return { plan: { cuts: [retakeCut] } };
				},
				async structural(req) {
					seen = req;
					return { plan: { drops: [] } };
				},
			}),
		});
		expect(seen).toBeDefined();
		expect(Array.isArray(seen!.handledSpans)).toBe(true);
		// The retake cut is an OFFERED removal folded before the structural mask, so its span
		// is a handled span the structural pass is told not to re-propose.
		expect(
			seen!.handledSpans!.some((s) => s.startSec < 3.5 && 3.0 < s.endSec),
		).toBe(true);
	});

	test("a thrown structural planner leaves the run intact (fail-open)", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const baseline = await buildDirectorProposals({ ...input, llm: stubLlm() });
		const thrown = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				async structural() {
					throw new Error("route 500");
				},
			}),
		});
		expect(thrown.operations).toEqual(baseline.operations);
	});
});
