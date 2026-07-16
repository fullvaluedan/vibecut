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
import type { ClaudeAuth, VerifyCandidate } from "@framecut/hf-bridge";

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
	calls: { director: number; redundancy: number; context: number; retake: number; structural: number; verify: number };
} {
	const calls = { director: 0, redundancy: 0, context: 0, retake: 0, structural: 0, verify: 0 };
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
		retake: async () => {
			calls.retake++;
			return { plan: { cuts: [] }, usage: {} };
		},
		structural: async () => {
			calls.structural++;
			return { plan: { drops: [] }, usage: {} };
		},
		verify: async () => {
			calls.verify++;
			return { plan: { verdicts: [] }, usage: {} };
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

	test("a changed compressionTarget busts the plan cache AND is forwarded to the planner (U3)", async () => {
		const seen: unknown[] = [];
		const { planners, calls } = countingPlanners({
			director: (async (arg: { compressionTarget?: unknown }) => {
				calls.director++;
				seen.push(arg.compressionTarget);
				return { plan: { operations: [] }, usage: {} };
			}) as unknown as EvalPlanners["director"],
		});
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners });
		await adapter.plan({ segments: [], totalSec: 5, compressionTarget: 0.4 });
		await adapter.plan({ segments: [], totalSec: 5, compressionTarget: 0.4 }); // same → cache hit
		await adapter.plan({ segments: [], totalSec: 5, compressionTarget: 0.6 }); // changed → miss
		await adapter.plan({ segments: [], totalSec: 5 }); // absent → distinct key, miss
		expect(calls.director).toBe(3); // 0.4 (miss), 0.4 (hit), 0.6 (miss), none (miss)
		expect(seen).toEqual([0.4, 0.6, undefined]); // the target reaches the planner unchanged
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

	test("retake caches by payload hash and replays without re-calling the planner (U3)", async () => {
		const { planners, calls } = countingPlanners();
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableRetake: true });
		const payload = { words: [{ text: "a", startSec: 0, endSec: 0.4 }] };

		const first = await adapter.retake!(payload);
		expect(first.plan?.cuts).toEqual([]);
		expect(calls.retake).toBe(1);
		expect(fs.readdirSync(cacheDir).some((f) => f.startsWith("retake-"))).toBe(true);

		// Identical payload → served from cache, planner NOT invoked again.
		await adapter.retake!(payload);
		expect(calls.retake).toBe(1);
	});

	test("a changed handledSpans busts the retake cache and is forwarded (KTD7)", async () => {
		const seen: unknown[] = [];
		const { planners, calls } = countingPlanners({
			retake: (async (arg: { handledSpans?: unknown }) => {
				calls.retake++;
				seen.push(arg.handledSpans);
				return { plan: { cuts: [] }, usage: {} };
			}) as unknown as EvalPlanners["retake"],
		});
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableRetake: true });
		const words = [{ text: "a", startSec: 0, endSec: 0.4 }];
		const spans = [{ startSec: 0, endSec: 1 }];
		await adapter.retake!({ words, handledSpans: spans });
		await adapter.retake!({ words, handledSpans: spans }); // same → cache hit
		await adapter.retake!({ words, handledSpans: [{ startSec: 0, endSec: 2 }] }); // changed → miss
		await adapter.retake!({ words }); // absent → distinct key, miss
		expect(calls.retake).toBe(3);
		expect(seen).toEqual([spans, [{ startSec: 0, endSec: 2 }], undefined]); // forwarded unchanged
	});

	test("retake is OMITTED by default and with enableRetake false (off mirrors the app)", () => {
		const { planners } = countingPlanners();
		const on = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableRetake: true });
		const byDefault = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners });
		const off = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableRetake: false });
		expect(typeof on.retake).toBe("function");
		expect(byDefault.retake).toBeUndefined();
		expect(off.retake).toBeUndefined();
	});

	test("structural caches by payload hash and replays without re-calling the planner (U2)", async () => {
		const { planners, calls } = countingPlanners();
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableStructural: true });
		const payload = { lines: [{ lineId: "L0", startSec: 0, endSec: 1, text: "hi" }] };

		const first = await adapter.structural!(payload);
		expect(first.plan?.drops).toEqual([]);
		expect(calls.structural).toBe(1);
		expect(fs.readdirSync(cacheDir).some((f) => f.startsWith("structural-"))).toBe(true);

		// Identical payload → served from cache, planner NOT invoked again.
		await adapter.structural!(payload);
		expect(calls.structural).toBe(1);
	});

	test("a changed handledSpans busts the structural cache and is forwarded (KTD7)", async () => {
		const seen: unknown[] = [];
		const { planners, calls } = countingPlanners({
			structural: (async (arg: { handledSpans?: unknown }) => {
				calls.structural++;
				seen.push(arg.handledSpans);
				return { plan: { drops: [] }, usage: {} };
			}) as unknown as EvalPlanners["structural"],
		});
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableStructural: true });
		const lines = [{ lineId: "L0", startSec: 0, endSec: 1, text: "hi" }];
		const spans = [{ startSec: 0, endSec: 1 }];
		await adapter.structural!({ lines, handledSpans: spans });
		await adapter.structural!({ lines, handledSpans: spans }); // same → cache hit
		await adapter.structural!({ lines, handledSpans: [{ startSec: 0, endSec: 2 }] }); // changed → miss
		await adapter.structural!({ lines }); // absent → distinct key, miss
		expect(calls.structural).toBe(3);
		expect(seen).toEqual([spans, [{ startSec: 0, endSec: 2 }], undefined]); // forwarded unchanged
	});

	test("structuralRemovalHint overrides the request hint AND busts the cache (eval --structural)", async () => {
		const seen: unknown[] = [];
		const { planners, calls } = countingPlanners({
			structural: (async (arg: { removalHint?: unknown }) => {
				calls.structural++;
				seen.push(arg.removalHint);
				return { plan: { drops: [] }, usage: {} };
			}) as unknown as EvalPlanners["structural"],
		});
		const adapter = createEvalLlmAdapter({
			auth: AUTH,
			cacheDir,
			planners,
			enableStructural: true,
			structuralRemovalHint: "This creator removes roughly 80% of raw words in the finished cut",
		});
		const lines = [{ lineId: "L0", startSec: 0, endSec: 1, text: "hi" }];
		// The request carries a DIFFERENT hint; the runner-supplied one wins.
		await adapter.structural!({ lines, removalHint: "ignored request hint" });
		expect(calls.structural).toBe(1);
		expect(seen[0]).toBe("This creator removes roughly 80% of raw words in the finished cut");
	});

	test("structural is OMITTED by default and with enableStructural false (off mirrors the app)", () => {
		const { planners } = countingPlanners();
		const on = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableStructural: true });
		const byDefault = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners });
		const off = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableStructural: false });
		expect(typeof on.structural).toBe("function");
		expect(byDefault.structural).toBeUndefined();
		expect(off.structural).toBeUndefined();
	});

	const mkCandidate = (
		over: Partial<VerifyCandidate> = {},
	): VerifyCandidate => ({
		category: "retake",
		startSec: 0,
		endSec: 1,
		reason: "flub",
		confidence: 0.7,
		coveredText: "a",
		startWord: 0,
		endWord: 0,
		...over,
	});

	test("verify caches by payload hash and replays without re-calling the planner (U2)", async () => {
		const { planners, calls } = countingPlanners();
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableVerify: true });
		const payload = {
			candidates: [mkCandidate()],
			lines: [],
			words: [{ text: "a", startSec: 0, endSec: 0.4 }],
		};

		const first = await adapter.verify!(payload);
		expect(first.plan?.verdicts).toEqual([]);
		expect(calls.verify).toBe(1);
		expect(fs.readdirSync(cacheDir).some((f) => f.startsWith("verify-"))).toBe(true);

		// Identical payload → served from cache, planner NOT invoked again.
		await adapter.verify!(payload);
		expect(calls.verify).toBe(1);
	});

	test("a changed candidate list busts the verify cache and is forwarded", async () => {
		const seen: unknown[] = [];
		const { planners, calls } = countingPlanners({
			verify: (async (arg: { candidates?: unknown }) => {
				calls.verify++;
				seen.push(arg.candidates);
				return { plan: { verdicts: [] }, usage: {} };
			}) as unknown as EvalPlanners["verify"],
		});
		const adapter = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableVerify: true });
		const lines: never[] = [];
		const words = [{ text: "a", startSec: 0, endSec: 0.4 }];
		const c1: VerifyCandidate[] = [mkCandidate()];
		const c2: VerifyCandidate[] = [
			mkCandidate({
				category: "structural",
				startWord: undefined,
				endWord: undefined,
				startLineId: "L0",
				endLineId: "L0",
			}),
		];
		await adapter.verify!({ candidates: c1, lines, words });
		await adapter.verify!({ candidates: c1, lines, words }); // same → cache hit
		await adapter.verify!({ candidates: c2, lines, words }); // changed → miss
		expect(calls.verify).toBe(2);
		expect(seen).toEqual([c1, c2]); // forwarded unchanged
	});

	test("verify is OMITTED by default and with enableVerify false (off mirrors the app)", () => {
		const { planners } = countingPlanners();
		const on = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableVerify: true });
		const byDefault = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners });
		const off = createEvalLlmAdapter({ auth: AUTH, cacheDir, planners, enableVerify: false });
		expect(typeof on.verify).toBe("function");
		expect(byDefault.verify).toBeUndefined();
		expect(off.verify).toBeUndefined();
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
