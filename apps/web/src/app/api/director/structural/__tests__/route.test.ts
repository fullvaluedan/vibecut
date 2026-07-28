import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// Stub the auth resolver and the planner so the route's guard / validate / error
// logic is tested without a real LLM call. Registered before importing the route.
// (planStructural is a VALUE import in the route: the mock MUST export it or the
// route fails to load.) bun's mock.module is process-global, so whichever mock is
// active when the sibling director routes load must also satisfy THEIR imports,
// hence the inert siblings, matching the plan/redundancy/context/retake route tests.
let authImpl: () => unknown = () => null;
let planStructuralImpl: () => Promise<unknown> = async () => ({
	plan: { drops: [] },
	usage: null,
});
let lastLines: unknown = undefined;

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));
mock.module("@framecut/hf-bridge", () => ({
	planStructural: (arg: { lines?: unknown }) => {
		lastLines = arg?.lines;
		return planStructuralImpl();
	},
	// Inert here, present so the sibling director route tests' process-global
	// mock.module doesn't leave their planner imports unsatisfied.
	planRedundancy: async () => ({ plan: { groups: [] }, usage: null }),
	planDirector: async () => ({ plan: { operations: [] }, usage: null }),
	planDirectorVision: async () => ({ plan: { operations: [] }, usage: null, degraded: false }),
	planContext: async () => ({ plan: { topic: "", flags: [] }, usage: null }),
	planRetake: async () => ({ plan: { cuts: [] }, usage: null }),
	planVerify: async () => ({ plan: { verdicts: [] }, usage: null }),
}));

const { POST } = await import("../route");

function post(body?: unknown): NextRequest {
	return new NextRequest("http://localhost/api/director/structural", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const goodLines = [
	{ lineId: "L0", startSec: 0, endSec: 2, text: "so here's the plan" },
	{ lineId: "L1", startSec: 2, endSec: 5, text: "let's build it" },
];

describe("/api/director/structural", () => {
	test("401 when AI auth is not configured (no upstream call)", async () => {
		authImpl = () => null;
		let planned = false;
		planStructuralImpl = async () => {
			planned = true;
			return { plan: { drops: [] }, usage: null };
		};
		const res = await POST(post({ lines: goodLines }));
		expect(res.status).toBe(401);
		expect(planned).toBe(false);
	});

	test("400 when lines is missing or not an array", async () => {
		authImpl = () => ({ mode: "claude-code" });
		expect((await POST(post({}))).status).toBe(400);
		expect((await POST(post({ lines: "nope" }))).status).toBe(400);
	});

	test("happy path returns the plan + usage and forwards parsed lines", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastLines = undefined;
		planStructuralImpl = async () => ({
			plan: {
				drops: [
					{
						startSec: 0,
						endSec: 2,
						reason: "off-throughline tangent",
						confidence: 0.8,
					},
				],
			},
			usage: { inputTokens: 7, outputTokens: 3 },
		});
		const res = await POST(post({ lines: goodLines, taste: "be conservative" }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.drops).toHaveLength(1);
		expect(json.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
		expect(Array.isArray(lastLines)).toBe(true);
	});

	test("drops malformed line entries when parsing", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastLines = undefined;
		await POST(
			post({
				lines: [
					{ lineId: "L0", startSec: 0, endSec: 2, text: "ok" },
					{ lineId: "L1", startSec: "bad", endSec: 4, text: "dropped: non-numeric start" },
					{ startSec: 4, endSec: 6, text: "dropped: no lineId" },
				],
			}),
		);
		expect(Array.isArray(lastLines)).toBe(true);
		if (Array.isArray(lastLines)) {
			expect(lastLines).toHaveLength(1);
			expect(lastLines[0].lineId).toBe("L0");
		}
	});

	test("empty lines array is valid (fail-open, R4) and still calls the planner", async () => {
		authImpl = () => ({ mode: "claude-code" });
		let planned = false;
		planStructuralImpl = async () => {
			planned = true;
			return { plan: { drops: [] }, usage: null };
		};
		const res = await POST(post({ lines: [] }));
		expect(res.status).toBe(200);
		expect(planned).toBe(true);
	});

	test("planner failure degrades to an empty plan without a 500 (R4 fail-open)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		planStructuralImpl = async () => {
			throw new Error("upstream boom");
		};
		const res = await POST(post({ lines: goodLines }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.drops).toEqual([]);
		expect(json.degraded).toBe(true);
	});
});
