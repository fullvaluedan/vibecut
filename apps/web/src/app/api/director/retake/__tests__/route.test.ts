import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// Stub the auth resolver and the planner so the route's guard / validate / error
// logic is tested without a real LLM call. Registered before importing the route.
// (planRetake is a VALUE import in the route — the mock MUST export it or the
// route fails to load.) bun's mock.module is process-global, so whichever mock is
// active when the sibling director routes load must also satisfy THEIR imports —
// hence the inert siblings, matching the redundancy/context/plan route tests.
let authImpl: () => unknown = () => null;
let planRetakeImpl: () => Promise<unknown> = async () => ({
	plan: { cuts: [] },
	usage: null,
});
let lastWords: unknown = undefined;

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));
mock.module("@framecut/hf-bridge", () => ({
	planRetake: (arg: { words?: unknown }) => {
		lastWords = arg?.words;
		return planRetakeImpl();
	},
	// Inert here, present so the sibling director route tests' process-global
	// mock.module doesn't leave their planner imports unsatisfied.
	planRedundancy: async () => ({ plan: { groups: [] }, usage: null }),
	planDirector: async () => ({ plan: { operations: [] }, usage: null }),
	planDirectorVision: async () => ({ plan: { operations: [] }, usage: null, degraded: false }),
	planContext: async () => ({ plan: { topic: "", flags: [] }, usage: null }),
}));

const { POST } = await import("../route");

function post(body?: unknown): NextRequest {
	return new NextRequest("http://localhost/api/director/retake", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const goodWords = [
	{ text: "so", startSec: 0, endSec: 0.2 },
	{ text: "the", startSec: 0.2, endSec: 0.4 },
	{ text: "trick", startSec: 0.4, endSec: 0.8 },
];

describe("/api/director/retake", () => {
	test("401 when AI auth is not configured (no upstream call)", async () => {
		authImpl = () => null;
		let planned = false;
		planRetakeImpl = async () => {
			planned = true;
			return { plan: { cuts: [] }, usage: null };
		};
		const res = await POST(post({ words: goodWords }));
		expect(res.status).toBe(401);
		expect(planned).toBe(false);
	});

	test("400 when words is missing or not an array", async () => {
		authImpl = () => ({ mode: "claude-code" });
		expect((await POST(post({}))).status).toBe(400);
		expect((await POST(post({ words: "nope" }))).status).toBe(400);
	});

	test("happy path returns the plan + usage and forwards parsed words", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastWords = undefined;
		planRetakeImpl = async () => ({
			plan: {
				cuts: [
					{
						startSec: 0,
						endSec: 0.4,
						reason: "abandoned false start before the clean restart",
						confidence: 0.8,
					},
				],
			},
			usage: { inputTokens: 7, outputTokens: 3 },
		});
		const res = await POST(post({ words: goodWords, taste: "be conservative" }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.cuts).toHaveLength(1);
		expect(json.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
		expect(Array.isArray(lastWords)).toBe(true);
	});

	test("drops malformed word entries when parsing", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastWords = undefined;
		await POST(
			post({
				words: [
					{ text: "ok", startSec: 0, endSec: 0.2 },
					{ text: "dropped — non-numeric start", startSec: "bad", endSec: 0.4 },
					{ startSec: 0.4, endSec: 0.6 },
				],
			}),
		);
		expect(Array.isArray(lastWords)).toBe(true);
		if (Array.isArray(lastWords)) {
			expect(lastWords).toHaveLength(1);
			expect(lastWords[0].text).toBe("ok");
		}
	});

	test("empty words array is valid (fail-open, R7) and still calls the planner", async () => {
		authImpl = () => ({ mode: "claude-code" });
		let planned = false;
		planRetakeImpl = async () => {
			planned = true;
			return { plan: { cuts: [] }, usage: null };
		};
		const res = await POST(post({ words: [] }));
		expect(res.status).toBe(200);
		expect(planned).toBe(true);
	});

	test("planner failure degrades to an empty plan without a 500 (R7 fail-open)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		planRetakeImpl = async () => {
			throw new Error("upstream boom");
		};
		const res = await POST(post({ words: goodWords }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.cuts).toEqual([]);
		expect(json.degraded).toBe(true);
	});
});
