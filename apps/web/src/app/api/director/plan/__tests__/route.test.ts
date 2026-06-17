import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// Stub the auth resolver and the planner so the route's guard / validate / error
// logic is tested without a real LLM call. Registered before importing the route.
let authImpl: () => unknown = () => null;
let planDirectorImpl: () => Promise<unknown> = async () => ({
	plan: { operations: [] },
	usage: null,
});

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));
mock.module("@framecut/hf-bridge", () => ({
	planDirector: () => planDirectorImpl(),
}));

const { POST } = await import("../route");

function post(body?: unknown): NextRequest {
	return new NextRequest("http://localhost/api/director/plan", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("/api/director/plan", () => {
	test("401 when AI auth is not configured (no upstream call)", async () => {
		authImpl = () => null;
		let planned = false;
		planDirectorImpl = async () => {
			planned = true;
			return { plan: { operations: [] }, usage: null };
		};
		const res = await POST(post({ segments: [], totalSec: 10 }));
		expect(res.status).toBe(401);
		expect(planned).toBe(false);
	});

	test("400 on an invalid body (missing segments / totalSec)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		expect((await POST(post({ totalSec: 5 }))).status).toBe(400);
		expect((await POST(post({ segments: [] }))).status).toBe(400);
	});

	test("happy path returns the sanitized plan + usage", async () => {
		authImpl = () => ({ mode: "claude-code" });
		planDirectorImpl = async () => ({
			plan: {
				operations: [
					{ id: "op_a", op: "cut", startSec: 1, endSec: 2, reason: "filler", confidence: 0.9 },
				],
			},
			usage: { inputTokens: 5, outputTokens: 2 },
		});
		const res = await POST(
			post({ segments: [{ startSec: 0, endSec: 5, text: "hi" }], totalSec: 5 }),
		);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.operations).toHaveLength(1);
		expect(json.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
	});

	test("500 when the planner throws", async () => {
		authImpl = () => ({ mode: "claude-code" });
		planDirectorImpl = async () => {
			throw new Error("upstream boom");
		};
		const res = await POST(post({ segments: [], totalSec: 5 }));
		expect(res.status).toBe(500);
		const json = await res.json();
		expect(json.error).toContain("Director planning failed");
	});
});
