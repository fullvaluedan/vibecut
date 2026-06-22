import { describe, expect, test } from "bun:test";
import {
	buildAssemblyPrompt,
	sanitizeAssemblyPlan,
	type AssemblyCandidate,
} from "@framecut/hf-bridge";

function candidate(
	partial: Partial<AssemblyCandidate> & { spanId: string },
): AssemblyCandidate {
	return {
		assetId: `asset-${partial.spanId}`,
		clipName: "clip.mp4",
		sourceStartSec: 0,
		sourceEndSec: 3,
		text: "a line",
		...partial,
	};
}

const CANDIDATES: AssemblyCandidate[] = [
	candidate({ spanId: "s1", assetId: "a", sourceStartSec: 0, sourceEndSec: 3 }),
	candidate({ spanId: "s2", assetId: "a", sourceStartSec: 3, sourceEndSec: 6 }),
	candidate({ spanId: "s3", assetId: "b", sourceStartSec: 0, sourceEndSec: 4 }),
];

describe("sanitizeAssemblyPlan (snap-to-candidate)", () => {
	test("keeps + resolves real spans in the model's order; drops hallucinated ids", () => {
		const plan = sanitizeAssemblyPlan(
			{
				narrative: "a story",
				spans: [
					{ spanId: "s3", reason: "hook first", confidence: 0.9 },
					{ spanId: "NOPE", reason: "hallucinated", confidence: 1 },
					{ spanId: "s1", reason: "body", confidence: 0.7 },
				],
			},
			CANDIDATES,
		);
		expect(plan.narrative).toBe("a story");
		expect(plan.spans.map((s) => s.spanId)).toEqual(["s3", "s1"]); // order kept, NOPE dropped
		expect(plan.spans[0]).toMatchObject({
			spanId: "s3",
			assetId: "b",
			sourceStartSec: 0,
			sourceEndSec: 4,
		});
	});

	test("drops a duplicate spanId (a span can appear at most once)", () => {
		const plan = sanitizeAssemblyPlan(
			{
				spans: [
					{ spanId: "s1", reason: "", confidence: 0.5 },
					{ spanId: "s1", reason: "again", confidence: 0.5 },
				],
			},
			CANDIDATES,
		);
		expect(plan.spans).toHaveLength(1);
	});

	test("clamps confidence and defaults a non-numeric one to 0.5", () => {
		const plan = sanitizeAssemblyPlan(
			{
				spans: [
					{ spanId: "s1", reason: "", confidence: 5 },
					{ spanId: "s2", reason: "", confidence: "nope" },
				],
			},
			CANDIDATES,
		);
		expect(plan.spans[0].confidence).toBe(1);
		expect(plan.spans[1].confidence).toBe(0.5);
	});

	test("malformed input yields an empty plan, never throws", () => {
		expect(sanitizeAssemblyPlan(null, CANDIDATES).spans).toEqual([]);
		expect(sanitizeAssemblyPlan({ spans: "x" }, CANDIDATES).spans).toEqual([]);
	});
});

describe("buildAssemblyPrompt", () => {
	test("lists every candidate id + clip and asks for JSON-only ordered spans", () => {
		const prompt = buildAssemblyPrompt({ candidates: CANDIDATES });
		expect(prompt).toContain("[s1]");
		expect(prompt).toContain("[s3]");
		expect(prompt).toContain("clip.mp4");
		expect(prompt).toContain("ONLY JSON");
		expect(prompt).toContain("FINAL ASSEMBLY ORDER");
	});
});
