import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// Stub the auth resolver and the planner so the route's guard / validate / error
// logic is tested without a real LLM call. Registered before importing the route.
// (planVerify is a VALUE import in the route: the mock MUST export it or the
// route fails to load.) bun's mock.module is process-global, so whichever mock is
// active when the sibling director routes load must also satisfy THEIR imports,
// hence the inert siblings, matching the plan/redundancy/context/retake/structural
// route tests.
let authImpl: () => unknown = () => null;
let planVerifyImpl: () => Promise<unknown> = async () => ({
	plan: { verdicts: [] },
	usage: null,
});
let lastCandidates: unknown = undefined;
let lastLines: unknown = undefined;
let lastWords: unknown = undefined;

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));
mock.module("@framecut/hf-bridge", () => ({
	planVerify: (arg: { candidates?: unknown; lines?: unknown; words?: unknown }) => {
		lastCandidates = arg?.candidates;
		lastLines = arg?.lines;
		lastWords = arg?.words;
		return planVerifyImpl();
	},
	// Inert here, present so the sibling director route tests' process-global
	// mock.module doesn't leave their planner imports unsatisfied.
	planRedundancy: async () => ({ plan: { groups: [] }, usage: null }),
	planDirector: async () => ({ plan: { operations: [] }, usage: null }),
	planDirectorVision: async () => ({ plan: { operations: [] }, usage: null, degraded: false }),
	planContext: async () => ({ plan: { topic: "", flags: [] }, usage: null }),
	planRetake: async () => ({ plan: { cuts: [] }, usage: null }),
	planStructural: async () => ({ plan: { drops: [] }, usage: null }),
}));

const { POST } = await import("../route");

function post(body?: unknown): NextRequest {
	return new NextRequest("http://localhost/api/director/verify", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const goodCandidates = [
	{
		category: "retake",
		startSec: 1.0,
		endSec: 1.9,
		reason: "abandoned false start",
		confidence: 0.7,
		coveredText: "world this",
		startWord: 2,
		endWord: 3,
	},
];

const goodLines = [
	{ lineId: "L0", startSec: 0, endSec: 2, text: "so here's the plan" },
	{ lineId: "L1", startSec: 2, endSec: 5, text: "let's build it" },
];

const goodWords = [
	{ text: "so", startSec: 0, endSec: 0.2 },
	{ text: "the", startSec: 0.2, endSec: 0.4 },
	{ text: "trick", startSec: 0.4, endSec: 0.8 },
];

describe("/api/director/verify", () => {
	test("401 when AI auth is not configured (no upstream call)", async () => {
		authImpl = () => null;
		let planned = false;
		planVerifyImpl = async () => {
			planned = true;
			return { plan: { verdicts: [] }, usage: null };
		};
		const res = await POST(
			post({ candidates: goodCandidates, lines: goodLines, words: goodWords }),
		);
		expect(res.status).toBe(401);
		expect(planned).toBe(false);
	});

	test("400 when candidates/lines/words is missing or not an array", async () => {
		authImpl = () => ({ mode: "claude-code" });
		expect((await POST(post({}))).status).toBe(400);
		expect((await POST(post({ candidates: "nope" }))).status).toBe(400);
		expect(
			(await POST(post({ candidates: [], lines: "nope", words: [] }))).status,
		).toBe(400);
		expect(
			(await POST(post({ candidates: [], lines: [], words: "nope" }))).status,
		).toBe(400);
	});

	test("happy path returns the plan + usage and forwards parsed candidates/lines/words", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastCandidates = undefined;
		lastLines = undefined;
		lastWords = undefined;
		planVerifyImpl = async () => ({
			plan: { verdicts: [{ index: 0, verdict: "reject" }] },
			usage: { inputTokens: 7, outputTokens: 3 },
		});
		const res = await POST(
			post({
				candidates: goodCandidates,
				lines: goodLines,
				words: goodWords,
				taste: "be conservative",
			}),
		);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.verdicts).toHaveLength(1);
		expect(json.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
		expect(Array.isArray(lastCandidates)).toBe(true);
		expect(Array.isArray(lastLines)).toBe(true);
		expect(Array.isArray(lastWords)).toBe(true);
	});

	test("empty candidates array is valid (fail-open, R4) and returns empty verdicts without planner failure", async () => {
		authImpl = () => ({ mode: "claude-code" });
		let planned = false;
		planVerifyImpl = async () => {
			planned = true;
			return { plan: { verdicts: [] }, usage: null };
		};
		const res = await POST(
			post({ candidates: [], lines: goodLines, words: goodWords }),
		);
		expect(res.status).toBe(200);
		expect(planned).toBe(true);
		const json = await res.json();
		expect(json.plan.verdicts).toEqual([]);
	});

	test("planner failure degrades to an empty plan without a 500 (R4 fail-open)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		planVerifyImpl = async () => {
			throw new Error("upstream boom");
		};
		const res = await POST(
			post({ candidates: goodCandidates, lines: goodLines, words: goodWords }),
		);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.verdicts).toEqual([]);
		expect(json.degraded).toBe(true);
	});
});
