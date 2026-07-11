import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createEvalLlmAdapter,
	resolveClaudeAuth,
	verifyClaudeCli,
	type EvalPlanners,
} from "../llm-adapter";
import type { ClaudeAuth } from "@framecut/hf-bridge";

const AUTH: ClaudeAuth = { mode: "claude-code" };

let cacheDir: string;
beforeEach(() => {
	cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cache-"));
});
afterEach(() => {
	fs.rmSync(cacheDir, { recursive: true, force: true });
});

/** Stub planners that count invocations; only the ones a test needs are real. */
function countingPlanners(overrides: Partial<EvalPlanners> = {}): {
	planners: EvalPlanners;
	calls: { director: number; redundancy: number; context: number };
} {
	const calls = { director: 0, redundancy: 0, context: 0 };
	const planners = {
		director: async () => {
			calls.director++;
			return { plan: { operations: [{ id: "op1", op: "cut", startSec: 1, endSec: 2, reason: "r", confidence: 0.9 }] }, usage: { inputTokens: 10 } };
		},
		vision: async () => ({ plan: { operations: [] }, usage: {}, degraded: false }),
		redundancy: async () => {
			calls.redundancy++;
			return { plan: { groups: [] }, usage: {} };
		},
		context: async () => {
			calls.context++;
			return { plan: { flags: [] }, usage: {} };
		},
		...overrides,
	} as unknown as EvalPlanners;
	return { planners, calls };
}

describe("createEvalLlmAdapter", () => {
	test("returns parsed ops and writes a cache file; second call hits cache", async () => {
		const { planners, calls } = countingPlanners();
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners });
		const payload = { segments: [], totalSec: 5 };

		const first = await adapter.plan(payload);
		expect(first.plan?.operations?.[0]?.id).toBe("op1");
		expect(calls.director).toBe(1);
		// A cache file was written.
		expect(fs.readdirSync(cacheDir).some((f) => f.startsWith("plan-"))).toBe(true);

		// Identical payload → served from cache, planner NOT invoked again.
		const second = await adapter.plan(payload);
		expect(second.plan?.operations?.[0]?.id).toBe("op1");
		expect(calls.director).toBe(1);
	});

	test("runIndex varies the cache key (a new live pass runs)", async () => {
		const { planners, calls } = countingPlanners();
		const payload = { segments: [], totalSec: 5 };
		await createEvalLlmAdapter({ auth: AUTH, cacheDir, runIndex: 0, planners }).plan(payload);
		await createEvalLlmAdapter({ auth: AUTH, cacheDir, runIndex: 1, planners }).plan(payload);
		expect(calls.director).toBe(2); // different index → cache miss
	});

	test("watchdog rejects, naming the pass, when a pass never resolves", async () => {
		const neverPlanners = countingPlanners({
			redundancy: (() => new Promise(() => {})) as unknown as EvalPlanners["redundancy"],
		}).planners;
		const adapter = createEvalLlmAdapter({
			auth: AUTH,
			cacheDir,
			timeoutMs: 60,
			attempts: 1,
			planners: neverPlanners,
		});
		await expect(adapter.redundancy({ lines: [] })).rejects.toThrow(/redundancy.*watchdog|watchdog.*redundancy/);
	});

	test("redundancy + context are cached independently by pass name", async () => {
		const { planners, calls } = countingPlanners();
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners });
		await adapter.redundancy({ lines: [{ lineId: "L0", startSec: 0, endSec: 1, text: "hi" }] });
		await adapter.context({ lines: [{ lineId: "L0", startSec: 0, endSec: 1, text: "hi" }] });
		expect(calls.redundancy).toBe(1);
		expect(calls.context).toBe(1);
	});
});

describe("resolveClaudeAuth", () => {
	test("defaults to claude-code", () => {
		expect(resolveClaudeAuth({ mode: "claude-code" })).toEqual({ mode: "claude-code" });
	});
	test("api-key requires ANTHROPIC_API_KEY", () => {
		expect(() => resolveClaudeAuth({ mode: "api-key" })).toThrow(/ANTHROPIC_API_KEY/);
		expect(resolveClaudeAuth({ mode: "api-key", apiKey: "sk-x" })).toEqual({
			mode: "api-key",
			apiKey: "sk-x",
		});
	});
});

describe("verifyClaudeCli", () => {
	test("a missing binary produces the actionable install/auth message", () => {
		expect(() => verifyClaudeCli("claude-code-definitely-missing-xyz")).toThrow(
			/Claude CLI isn't available/,
		);
	});
});
