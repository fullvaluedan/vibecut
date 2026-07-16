import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// Stub the auth resolver and BOTH planners (text + vision) so the route's guard /
// validate / route-by-frames / error logic is tested without a real LLM call.
// Registered before importing the route.
let authImpl: () => unknown = () => null;
let planDirectorImpl: () => Promise<unknown> = async () => ({
	plan: { operations: [] },
	usage: null,
});
let planDirectorVisionImpl: () => Promise<unknown> = async () => ({
	plan: { operations: [] },
	usage: null,
	degraded: false,
});
// Which planner the route dispatched to + the catalog / compressionTarget it received.
let lastPlanner: "text" | "vision" | null = null;
let lastCatalog: unknown = undefined;
let lastCompressionTarget: unknown = "unset";

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));
mock.module("@framecut/hf-bridge", () => ({
	planDirector: (arg: { catalog?: unknown; compressionTarget?: unknown }) => {
		lastPlanner = "text";
		lastCatalog = arg?.catalog;
		lastCompressionTarget = arg?.compressionTarget;
		return planDirectorImpl();
	},
	planDirectorVision: (arg: { catalog?: unknown }) => {
		lastPlanner = "vision";
		lastCatalog = arg?.catalog;
		return planDirectorVisionImpl();
	},
	// Inert here, present so the sibling redundancy / context / retake route tests'
	// process-global mock.module doesn't leave those routes' `planRedundancy` /
	// `planContext` / `planRetake` imports unsatisfied when the route tests run in
	// one `bun test` dir.
	planRedundancy: async () => ({ plan: { groups: [] }, usage: null }),
	planContext: async () => ({ plan: { topic: "", flags: [] }, usage: null }),
	planRetake: async () => ({ plan: { cuts: [] }, usage: null }),
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

	test("happy path returns the sanitized plan + usage (text planner, not degraded)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastPlanner = null;
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
		// No frames → the text planner, and degraded defaults false (R3 contract).
		expect(lastPlanner).toBe("text");
		expect(json.degraded).toBe(false);
	});

	test("parses and forwards a multi-clip catalog to the planner, dropping malformed entries", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastCatalog = undefined;
		const catalog = [
			{ name: "a.mp4", durationSec: 30, segmentCount: 4, firstLine: "hi", lastLine: "bye" },
			{ name: "b.mp4", durationSec: 20, segmentCount: 2, firstLine: "yo", lastLine: "ok", junk: 1 },
			{ name: 123 }, // malformed → dropped
		];
		await POST(
			post({ segments: [{ startSec: 0, endSec: 5, text: "hi" }], totalSec: 5, catalog }),
		);
		expect(Array.isArray(lastCatalog)).toBe(true);
		if (Array.isArray(lastCatalog)) {
			expect(lastCatalog).toHaveLength(2); // the malformed third entry is dropped
			expect(lastCatalog[0].name).toBe("a.mp4");
		}
	});

	test("forwards no catalog when none is sent", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastCatalog = "sentinel";
		await POST(post({ segments: [{ startSec: 0, endSec: 5, text: "hi" }], totalSec: 5 }));
		expect(lastCatalog).toBeUndefined();
	});

	test("parses and forwards a numeric compressionTarget to the planner (U3)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastCompressionTarget = "unset";
		await POST(
			post({
				segments: [{ startSec: 0, endSec: 5, text: "hi" }],
				totalSec: 5,
				compressionTarget: 0.585,
			}),
		);
		expect(lastCompressionTarget).toBe(0.585);
	});

	test("drops a non-numeric compressionTarget silently (field absent, U3)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		for (const bad of ["0.5", null, {}, Number.NaN]) {
			lastCompressionTarget = "unset";
			const res = await POST(
				post({
					segments: [{ startSec: 0, endSec: 5, text: "hi" }],
					totalSec: 5,
					compressionTarget: bad,
				}),
			);
			expect(res.status).toBe(200); // never a 400 — just dropped
			expect(lastCompressionTarget).toBeUndefined();
		}
	});

	test("forwards no compressionTarget when none is sent (U3 byte-identical default)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastCompressionTarget = "unset";
		await POST(post({ segments: [{ startSec: 0, endSec: 5, text: "hi" }], totalSec: 5 }));
		expect(lastCompressionTarget).toBeUndefined();
	});

	test("routes to the VISION planner when valid frames are present, passing degraded through", async () => {
		authImpl = () => ({ mode: "api-key", apiKey: "k" });
		lastPlanner = null;
		planDirectorVisionImpl = async () => ({
			plan: {
				operations: [
					{ id: "op_v", op: "cut", startSec: 3, endSec: 4, reason: "off-screen", confidence: 0.8 },
				],
			},
			usage: { inputTokens: 99, outputTokens: 8 },
			degraded: true,
		});
		const res = await POST(
			post({
				segments: [{ startSec: 0, endSec: 5, text: "hi" }],
				totalSec: 5,
				frames: [{ segmentIndex: 0, mediaType: "image/jpeg", dataBase64: "AAAA" }],
			}),
		);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(lastPlanner).toBe("vision"); // frames → vision planner, not text
		expect(json.plan.operations).toHaveLength(1);
		expect(json.degraded).toBe(true); // the planner's degrade flag rides through
	});

	test("an empty / all-malformed frames array falls back to the text planner (not a 400)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		lastPlanner = null;
		// All entries malformed → parsed to [] → text path, no vision dispatch.
		const res = await POST(
			post({
				segments: [{ startSec: 0, endSec: 5, text: "hi" }],
				totalSec: 5,
				frames: [{ nope: true }],
			}),
		);
		expect(res.status).toBe(200);
		expect(lastPlanner).toBe("text");
	});

	test("400 when frames is present but not an array", async () => {
		authImpl = () => ({ mode: "claude-code" });
		const res = await POST(
			post({ segments: [], totalSec: 5, frames: "not-an-array" }),
		);
		expect(res.status).toBe(400);
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
