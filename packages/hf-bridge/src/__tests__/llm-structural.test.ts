import { describe, expect, test } from "bun:test";
import type { RedundancyLine } from "../llm-redundancy";
import {
	buildStructuralPrompt,
	planStructural,
	renderStructuralCatalog,
	sanitizeStructuralPlan,
} from "../llm-structural";
import type { ClaudeAuth } from "../types";

/** Non-overlapping, ascending lines: L#{i} spans [i*2, i*2 + 1.8]. */
const mkLines = (...texts: string[]): RedundancyLine[] =>
	texts.map((text, i) => ({
		lineId: `L${i}`,
		startSec: i * 2,
		endSec: i * 2 + 1.8,
		text,
	}));

describe("buildStructuralPrompt (load-bearing substrings)", () => {
	const prompt = buildStructuralPrompt({
		lines: mkLines("intro", "the point", "a tangent about lunch", "back to it"),
	});

	test("infers the throughline first (the judgment framing)", () => {
		expect(prompt).toContain("infer the video's throughline");
	});

	test("names the drop taxonomy: tangent, weak take, over-explanation, re-recorded", () => {
		const lower = prompt.toLowerCase();
		expect(lower).toContain("tangent");
		expect(lower).toContain("weak take");
		expect(lower).toContain("over-explanation");
		expect(lower).toContain("re-recorded");
	});

	test("demands a LINE RANGE via startLineId/endLineId", () => {
		expect(prompt).toContain("startLineId");
		expect(prompt).toContain("endLineId");
		expect(prompt).toContain("LINE RANGE");
	});

	test("each reason must name why the section fails the throughline", () => {
		expect(prompt).toContain("does not serve the throughline");
	});

	test("carries the RECALL license (over-proposing safe, review-only, never auto-applied)", () => {
		expect(prompt).toContain("EXHAUSTIVE RECALL");
		expect(prompt).toContain("Over-proposing is SAFE");
		expect(prompt).toContain("review-only row");
		expect(prompt).toContain("never auto-applied");
	});

	test("no undefined/NaN leaks, even for a feature-less line", () => {
		expect(prompt).not.toContain("undefined");
		expect(prompt).not.toContain("NaN");
		const out = renderStructuralCatalog([
			{ lineId: "L0", startSec: 0, endSec: 1, text: "" },
		]);
		expect(out).not.toContain("undefined");
		expect(out).not.toContain("NaN");
		expect(out).toContain('"-"'); // empty text falls back to "-"
	});
});

describe("buildStructuralPrompt byte-identity (absent optional blocks)", () => {
	const lines = mkLines("a", "b", "c");
	const bare = buildStructuralPrompt({ lines });

	test("absent/empty handledSpans yields a byte-identical prompt (no marker, no block)", () => {
		expect(buildStructuralPrompt({ lines, handledSpans: [] })).toBe(bare);
		expect(buildStructuralPrompt({ lines, handledSpans: undefined })).toBe(bare);
		expect(bare).not.toContain("[HANDLED]");
	});

	test("absent removalHint yields a byte-identical prompt with the generic wording", () => {
		expect(buildStructuralPrompt({ lines, removalHint: undefined })).toBe(bare);
		expect(bare).toContain("removes a large share of the raw footage");
	});
});

describe("buildStructuralPrompt removal hint", () => {
	const lines = mkLines("a", "b", "c");

	test("a provided removalHint appears verbatim, replacing the generic wording", () => {
		const hint = "This creator removes roughly 80% of raw words in the finished cut";
		const prompt = buildStructuralPrompt({ lines, removalHint: hint });
		expect(prompt).toContain(hint);
		expect(prompt).not.toContain("like most talking-head creators");
	});

	test("absent removalHint keeps the generic large-share wording", () => {
		const prompt = buildStructuralPrompt({ lines });
		expect(prompt).toContain("removes a large share of the raw footage");
	});
});

describe("buildStructuralPrompt handled-region mask", () => {
	// L0 spans [0, 1.8]; L1 spans [2, 3.8]; L2 spans [4, 5.8].
	const lines = mkLines("a", "b", "c");

	test("a section substantially covered by handledSpans is tagged [HANDLED]", () => {
		const prompt = buildStructuralPrompt({
			lines,
			handledSpans: [{ startSec: 0, endSec: 1.8 }], // covers L0 fully
		});
		expect(prompt).toContain("[L0] [HANDLED]");
		expect(prompt).not.toContain("[L1] [HANDLED]"); // uncovered line stays untagged
	});

	test("the mask instruction demands hunting the UNHANDLED sections", () => {
		const prompt = buildStructuralPrompt({
			lines,
			handledSpans: [{ startSec: 0, endSec: 1.8 }],
		});
		expect(prompt).toContain("DO NOT re-propose");
		expect(prompt).toContain("UNHANDLED");
	});
});

describe("sanitizeStructuralPlan (line-range -> seconds via the shared sanitizer)", () => {
	const lines = mkLines("a", "b", "c", "d"); // L0..L3

	test("a valid line range resolves to seconds (startLine.start .. endLine.end)", () => {
		const plan = sanitizeStructuralPlan(
			{
				operations: [
					{ startLineId: "L1", endLineId: "L2", reason: "tangent", confidence: 0.6 },
				],
			},
			lines,
		);
		expect(plan.drops).toHaveLength(1);
		expect(plan.drops[0]).toMatchObject({
			startSec: 2, // L1.startSec
			endSec: 5.8, // L2.endSec
			reason: "tangent",
			confidence: 0.6,
		});
	});

	test("an unknown lineId is dropped; a valid sibling survives", () => {
		const plan = sanitizeStructuralPlan(
			{
				operations: [
					{ startLineId: "L0", endLineId: "L1", reason: "ok", confidence: 0.7 },
					{ startLineId: "L2", endLineId: "L99", reason: "bad", confidence: 0.7 }, // unknown end id
				],
			},
			lines,
		);
		expect(plan.drops).toHaveLength(1);
		expect(plan.drops[0].startSec).toBe(0); // the valid sibling
	});

	test("a reversed range (end before start) is dropped", () => {
		const plan = sanitizeStructuralPlan(
			{
				operations: [
					{ startLineId: "L2", endLineId: "L0", reason: "reversed", confidence: 0.7 },
				],
			},
			lines,
		);
		expect(plan.drops).toEqual([]);
	});

	test("never throws on malformed shapes (yields zero drops)", () => {
		expect(sanitizeStructuralPlan("not json{", lines).drops).toEqual([]);
		expect(sanitizeStructuralPlan({}, lines).drops).toEqual([]);
		expect(sanitizeStructuralPlan(null, lines).drops).toEqual([]);
	});
});

describe("planStructural fail-open (R4)", () => {
	// A custom endpoint that would REJECT fast if dispatched - proves the empty-lines
	// guard returns BEFORE any LLM call (a live call would fetch this dead host).
	const NO_CALL_AUTH: ClaudeAuth = {
		mode: "custom",
		baseUrl: "http://127.0.0.1:9/v1",
		model: "unused",
	};

	test("empty line catalog -> zero candidates WITHOUT invoking the LLM", async () => {
		await expect(planStructural({ lines: [], auth: NO_CALL_AUTH })).resolves.toEqual({
			plan: { drops: [] },
			usage: null,
		});
	});
});
