import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// Stub the auth resolver and the planner so the route's guard / validate / error
// logic is tested without a real LLM call. bun's mock.module is process-global, so
// the hf-bridge stub must satisfy every director route's imports (plan / redundancy /
// context) when they run together in one `bun test` dir, hence the inert siblings.
let authImpl: () => unknown = () => null;
let planContextImpl: () => Promise<unknown> = async () => ({
	plan: { topic: "", flags: [] },
	usage: null,
});
let lastLines: unknown = undefined;

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));
mock.module("@framecut/hf-bridge", () => ({
	planContext: (arg: { lines?: unknown }) => {
		lastLines = arg?.lines;
		return planContextImpl();
	},
	// Inert siblings so the plan/redundancy/retake/structural route imports stay
	// satisfied under the shared process-global mock.
	planRedundancy: async () => ({ plan: { groups: [] }, usage: null }),
	planDirector: async () => ({ plan: { operations: [] }, usage: null }),
	planDirectorVision: async () => ({ plan: { operations: [] }, usage: null, degraded: false }),
	planRetake: async () => ({ plan: { cuts: [] }, usage: null }),
	planStructural: async () => ({ plan: { drops: [] }, usage: null }),
	planVerify: async () => ({ plan: { verdicts: [] }, usage: null }),
}));

const { POST } = await import("../route");

function post(body?: unknown): NextRequest {
	return new NextRequest("http://localhost/api/director/context", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const goodLines = [
	{ lineId: "L0", startSec: 0, endSec: 2, text: "how to build a website" },
	{ lineId: "L1", startSec: 3, endSec: 5, text: "wait let me redo that" },
];

describe("/api/director/context", () => {
	test("401 when AI auth is not configured (no upstream call)", async () => {
		authImpl = () => null;
		let planned = false;
		planContextImpl = async () => {
			planned = true;
			return { plan: { topic: "", flags: [] }, usage: null };
		};
		const res = await POST(post({ lines: goodLines }));
		expect(res.status).toBe(401);
		expect(planned).toBe(false);
	});

	test("400 when lines is missing or not an array", async () => {
		authImpl = () => ({ mode: "claude-code" });
		expect((await POST(post({}))).status).toBe(400);
		expect((await POST(post({ lines: "nope" }))).status).toBe(400);
		expect((await POST(post({ lines: [] }))).status).toBe(400);
	});

	test("happy path returns the plan + usage and forwards parsed lines", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastLines = undefined;
		planContextImpl = async () => ({
			plan: {
				topic: "how to build a website",
				flags: [{ lineId: "L1", startSec: 3, endSec: 5, text: "wait let me redo that", confidence: 0.8, reason: "meta aside" }],
			},
			usage: { inputTokens: 7, outputTokens: 3 },
		});
		const res = await POST(post({ lines: goodLines, taste: "be conservative" }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.topic).toBe("how to build a website");
		expect(json.plan.flags).toHaveLength(1);
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
					{ lineId: "L1", startSec: "bad", endSec: 5, text: "dropped, non-numeric start" },
					{ startSec: 6, endSec: 8, text: "dropped, no lineId" },
				],
			}),
		);
		expect(Array.isArray(lastLines)).toBe(true);
		if (Array.isArray(lastLines)) {
			expect(lastLines).toHaveLength(1);
			expect(lastLines[0].lineId).toBe("L0");
		}
	});

	test("500 when the planner throws", async () => {
		authImpl = () => ({ mode: "claude-code" });
		planContextImpl = async () => {
			throw new Error("upstream boom");
		};
		const res = await POST(post({ lines: goodLines }));
		expect(res.status).toBe(500);
		const json = await res.json();
		expect(json.error).toContain("Context planning failed");
	});
});
