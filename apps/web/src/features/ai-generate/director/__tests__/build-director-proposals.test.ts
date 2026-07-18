import { describe, expect, test } from "bun:test";
import {
	buildDirectorProposals,
	type DirectorLlmAdapter,
	type DirectorRetakeRequest,
	type DirectorVerifyRequest,
	type DirectorVerifyResponse,
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

/**
 * U2 verify sub-pass wiring (R3/R4). The pass is OPTIONAL on the adapter and runs
 * immediately after the recall fold: reject removes a candidate row, keep/no-verdict
 * pass through. It fires ONLY when recall candidates exist (zero → no call), and any
 * failure (absent method, thrown, degraded) leaves every candidate untouched.
 */
describe("buildDirectorProposals + verify pass (U2)", () => {
	const SENTENCE =
		"so um lets deploy the the project and now we verify the logs together carefully";
	const cleanStructural: StructuralDrop = {
		startSec: 3.0,
		endSec: 3.5,
		reason: "off-throughline tangent",
		confidence: 0.9,
	};
	// A structural drop in a clean region survives the fold as one OFFERED row, so the
	// verify pass has exactly one candidate to judge.
	const structuralStub = (drops: StructuralDrop[]) => ({
		async structural() {
			return { plan: { drops } };
		},
	});

	test("an adapter WITHOUT verify matches one whose verify returns no verdicts (byte-identical)", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const noVerify = await buildDirectorProposals({
			...input,
			llm: stubLlm(structuralStub([cleanStructural])),
		});
		const emptyVerify = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				...structuralStub([cleanStructural]),
				async verify() {
					return { plan: { verdicts: [] } };
				},
			}),
		});
		// Empty verdicts = every candidate kept, so the op list is byte-identical to the
		// verify-method-absent pipeline.
		expect(emptyVerify.operations).toEqual(noVerify.operations);
	});

	test("a thrown verify pass leaves every candidate untouched (fail-open pin)", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		const noVerify = await buildDirectorProposals({
			...input,
			llm: stubLlm(structuralStub([cleanStructural])),
		});
		const thrownVerify = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				...structuralStub([cleanStructural]),
				async verify() {
					throw new Error("route 500");
				},
			}),
		});
		expect(thrownVerify.operations).toEqual(noVerify.operations);
	});

	test("zero recall candidates → the verify pass is NEVER invoked (call-count pin)", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		let verifyCalls = 0;
		// No retake/structural stub → the always-on detectors produce only non-candidate
		// categories (duplicate/filler/...), so there is nothing for verify to judge.
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				async verify() {
					verifyCalls++;
					return { plan: { verdicts: [] } };
				},
			}),
		});
		expect(verifyCalls).toBe(0);
		expect(Array.isArray(result.operations)).toBe(true);
	});

	test("zero recall candidates AND zero join fragments → verify is never invoked", async () => {
		// Same fixture as the call-count pin above, spelled against the round 12 U2
		// fire condition: this fixture strands no join fragment either, so the
		// extended condition (candidates OR fragments) still never fires.
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		let verifyCalls = 0;
		await buildDirectorProposals({
			...input,
			llm: stubLlm({
				async verify(req: DirectorVerifyRequest) {
					verifyCalls++;
					void req;
					return { plan: { verdicts: [] } };
				},
			}),
		});
		expect(verifyCalls).toBe(0);
	});

	test("a reject verdict removes a structural row end-to-end through the pipeline", async () => {
		const words = mkWords(SENTENCE);
		const input = baseInput(words, 7);
		// Control: with no verify, the structural candidate survives to the final ops.
		const kept = await buildDirectorProposals({
			...input,
			llm: stubLlm(structuralStub([cleanStructural])),
		});
		expect(kept.operations.some((o) => o.category === "structural")).toBe(true);

		// Reject every candidate the verify pass is handed → the structural row is gone
		// from the final ops (removed before the snap/refine/trim/justify chain).
		const rejected = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				...structuralStub([cleanStructural]),
				async verify(req: DirectorVerifyRequest) {
					return {
						plan: {
							verdicts: req.candidates.map((_, i) => ({
								index: i,
								verdict: "reject" as const,
							})),
						},
					};
				},
			}),
		});
		expect(rejected.operations.some((o) => o.category === "structural")).toBe(false);
	});
});

/**
 * Round 12 U2: the FINAL-READ side of the verify pass. Two default-accepted plan
 * cuts strand one word between them, so the join-texture layer mints an OFFERED
 * fragment row; the extended fire condition sends it to verify (join fragments
 * ALONE, zero recall candidates), the request carries the assembled transcript +
 * fragment rows, and a confident swallow verdict promotes the row while keep /
 * low confidence / malformed responses leave it OFFERED.
 */
describe("buildDirectorProposals + final read (round 12 U2)", () => {
	const SENTENCE =
		"so um lets deploy the the project and now we verify the logs together carefully";
	// Words are 0.3s-spaced: cut words 2-6 and 8-12, stranding word 7 ("and",
	// [2.1, 2.38]) between two accepted removals.
	const planCuts: DirectorOp[] = [
		{
			id: "plan-a",
			op: "cut",
			startSec: 0.6,
			endSec: 2.08,
			reason: "weak setup",
			confidence: 0.9,
		},
		{
			id: "plan-b",
			op: "cut",
			startSec: 2.4,
			endSec: 3.88,
			reason: "restated later",
			confidence: 0.9,
		},
	];
	const planStub = {
		async plan() {
			return { plan: { operations: planCuts } };
		},
	};
	/** baseInput with FLAT delivery features (quiet, too-fast) so no segment
	 * crosses the importance PROTECT_FLOOR - a protected segment would veto the
	 * second plan cut in the merge and no join could form. */
	const flatInput = (words: TranscriptionWord[]) => {
		const base = baseInput(words, 7);
		return {
			...base,
			features: base.features.map((f) => ({
				...f,
				loudnessRelative: 0.2,
				wpm: 300,
			})),
		};
	};
	/** The OFFERED join-fragment rows in a final op list. */
	const fragmentRows = (ops: readonly DirectorOp[]) =>
		ops.filter((o) => o.category === "join" && o.defaultAccept === false);

	test("join fragments ALONE fire verify, carrying the assembled transcript + fragment rows", async () => {
		const words = mkWords(SENTENCE);
		const input = flatInput(words);
		let verifyCalls = 0;
		let captured: DirectorVerifyRequest | undefined;
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				...planStub,
				async verify(req: DirectorVerifyRequest) {
					verifyCalls++;
					captured = req;
					return { plan: { verdicts: [] } };
				},
			}),
		});
		// No retake/structural stubs → zero recall candidates, yet verify FIRED.
		expect(verifyCalls).toBe(1);
		expect(captured!.candidates).toHaveLength(0);
		// The fragment rows ride the request: the stranded "and" with kept context.
		const frags = captured!.joinFragments ?? [];
		expect(frags.length).toBeGreaterThan(0);
		const andFrag = frags.find((f) => f.text === "and");
		expect(andFrag).toBeDefined();
		// The assembled post-cut transcript rides along, seam-marked.
		expect(captured!.assembledTranscript).toContain("[CUT]");
		expect(captured!.assembledTranscript).toContain("and");
		// With no verdicts returned, the fragment row ships OFFERED.
		expect(fragmentRows(result.operations).length).toBeGreaterThan(0);
	});

	test("a confident swallow verdict promotes the join row to checked", async () => {
		const words = mkWords(SENTENCE);
		const input = flatInput(words);
		const result = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				...planStub,
				async verify(req: DirectorVerifyRequest) {
					return {
						plan: {
							verdicts: [],
							joinVerdicts: (req.joinFragments ?? []).map((f) => ({
								id: f.id,
								verdict: "swallow" as const,
								confidence: 0.9,
							})),
						},
					};
				},
			}),
		});
		// Every fragment row was promoted: none left OFFERED, at least one join op
		// now explicitly checked.
		expect(fragmentRows(result.operations)).toHaveLength(0);
		expect(
			result.operations.some(
				(o) => o.category === "join" && o.defaultAccept === true,
			),
		).toBe(true);
	});

	test("keep and low-confidence swallow verdicts leave the row OFFERED", async () => {
		const words = mkWords(SENTENCE);
		const input = flatInput(words);
		const run = async (verdict: "keep" | "swallow", confidence: number) =>
			buildDirectorProposals({
				...input,
				llm: stubLlm({
					...planStub,
					async verify(req: DirectorVerifyRequest) {
						return {
							plan: {
								verdicts: [],
								joinVerdicts: (req.joinFragments ?? []).map((f) => ({
									id: f.id,
									verdict,
									confidence,
								})),
							},
						};
					},
				}),
			});
		const keep = await run("keep", 0.95);
		expect(fragmentRows(keep.operations).length).toBeGreaterThan(0);
		const unsure = await run("swallow", 0.5);
		expect(fragmentRows(unsure.operations).length).toBeGreaterThan(0);
	});

	test("a malformed or thrown verify response leaves every join row OFFERED (fail-open)", async () => {
		const words = mkWords(SENTENCE);
		const input = flatInput(words);
		// Baseline: no verify at all → the fragment row exists, OFFERED.
		const baseline = await buildDirectorProposals({
			...input,
			llm: stubLlm(planStub),
		});
		const offered = fragmentRows(baseline.operations);
		expect(offered.length).toBeGreaterThan(0);

		const malformed = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				...planStub,
				async verify() {
					return {
						plan: { verdicts: [], joinVerdicts: "garbage" },
					} as unknown as DirectorVerifyResponse;
				},
			}),
		});
		expect(malformed.operations).toEqual(baseline.operations);

		const thrown = await buildDirectorProposals({
			...input,
			llm: stubLlm({
				...planStub,
				async verify() {
					throw new Error("route 500");
				},
			}),
		});
		expect(thrown.operations).toEqual(baseline.operations);
	});
});
