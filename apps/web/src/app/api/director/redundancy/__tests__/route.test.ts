import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// Stub the auth resolver and the planner so the route's guard / validate / error
// logic is tested without a real LLM call. Registered before importing the route.
// (planRedundancy is a VALUE import in the route — the mock MUST export it or the
// route fails to load; the prior vision regression was an incomplete mock.)
let authImpl: () => unknown = () => null;
let planRedundancyImpl: () => Promise<unknown> = async () => ({
	plan: { groups: [] },
	usage: null,
});
let lastLines: unknown = undefined;

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));
mock.module("@framecut/hf-bridge", () => ({
	planRedundancy: (arg: { lines?: unknown }) => {
		lastLines = arg?.lines;
		return planRedundancyImpl();
	},
}));

const { POST } = await import("../route");

function post(body?: unknown): NextRequest {
	return new NextRequest("http://localhost/api/director/redundancy", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const goodLines = [
	{ lineId: "L0", startSec: 0, endSec: 2, text: "we ship friday" },
	{ lineId: "L1", startSec: 3, endSec: 5, text: "the launch is friday" },
];

describe("/api/director/redundancy", () => {
	test("401 when AI auth is not configured (no upstream call)", async () => {
		authImpl = () => null;
		let planned = false;
		planRedundancyImpl = async () => {
			planned = true;
			return { plan: { groups: [] }, usage: null };
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
		planRedundancyImpl = async () => ({
			plan: {
				groups: [
					{
						members: [
							{ lineId: "L0", startSec: 0, endSec: 2, text: "we ship friday" },
							{ lineId: "L1", startSec: 3, endSec: 5, text: "the launch is friday" },
						],
						keeperLineId: "L1",
						confidence: 0.9,
						reason: "same point",
					},
				],
			},
			usage: { inputTokens: 7, outputTokens: 3 },
		});
		const res = await POST(post({ lines: goodLines, taste: "be conservative" }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.plan.groups).toHaveLength(1);
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
					{ lineId: "L1", startSec: "bad", endSec: 5, text: "dropped — non-numeric start" },
					{ startSec: 6, endSec: 8, text: "dropped — no lineId" },
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
		planRedundancyImpl = async () => {
			throw new Error("upstream boom");
		};
		const res = await POST(post({ lines: goodLines }));
		expect(res.status).toBe(500);
		const json = await res.json();
		expect(json.error).toContain("Redundancy planning failed");
	});
});
