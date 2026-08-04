import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEvalLlmAdapter, type EvalPlanners } from "../llm-adapter";
import type { ClaudeAuth } from "@framecut/hf-bridge";

/**
 * T21.2 eval cache-key stability proof. The disk cache under `.eval-cache/`
 * keys every pass on sha256(passName, payload, authMode, model, runIndex).
 * The provider abstraction adds NEW auth modes but must not change the key
 * any EXISTING mode produces - or every cached Anthropic plan would silently
 * miss and the next eval run would re-burn the whole suite live. These tests
 * pin the exact cache filename for the pre-T21.2 modes against a golden
 * recomputation of the documented ingredients.
 */

let cacheDir: string;
beforeEach(() => {
	cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cache-key-"));
});
afterEach(() => {
	fs.rmSync(cacheDir, { recursive: true, force: true });
});

const planners: EvalPlanners = {
	director: async () => ({ plan: { operations: [] }, usage: null }),
	vision: async () => ({ plan: { operations: [] }, usage: null, degraded: false }),
	redundancy: async () => ({ plan: { groups: [] }, usage: null }),
	context: async () => ({ plan: { topic: "", flags: [] }, usage: null }),
	retake: async () => ({ plan: { cuts: [] }, usage: null }),
	structural: async () => ({ plan: { drops: [] }, usage: null }),
	verify: async () => ({ plan: { verdicts: [], joinVerdicts: [], harmVerdicts: [] } }),
} as unknown as EvalPlanners;

/** Recompute the documented cache key exactly as llm-adapter's hashKey does. */
function goldenKey(parts: {
	passName: string;
	payload: unknown;
	authMode: string;
	model: string;
	runIndex: number;
}): string {
	return createHash("sha256")
		.update(JSON.stringify(parts))
		.digest("hex")
		.slice(0, 40);
}

describe("eval cache-key stability for the pre-T21.2 auth modes", () => {
	test("claude-code: the plan cache filename matches the golden key", async () => {
		const auth: ClaudeAuth = { mode: "claude-code" };
		const adapter = createEvalLlmAdapter({ auth, cacheDir, planners });
		await adapter.plan({ segments: [], totalSec: 5 });

		const expected = goldenKey({
			passName: "plan",
			payload: { segments: [], totalSec: 5, promptVersion: 2 },
			authMode: "claude-code",
			model: "",
			runIndex: 0,
		});
		expect(fs.readdirSync(cacheDir)).toEqual([`plan-${expected}.json`]);
	});

	test("api-key: same payload, same key shape - only authMode differs", async () => {
		const auth: ClaudeAuth = { mode: "api-key", apiKey: "sk-ant-1" };
		const adapter = createEvalLlmAdapter({ auth, cacheDir, planners });
		await adapter.plan({ segments: [], totalSec: 5 });

		const expected = goldenKey({
			passName: "plan",
			payload: { segments: [], totalSec: 5, promptVersion: 2 },
			authMode: "api-key",
			model: "",
			runIndex: 0,
		});
		expect(fs.readdirSync(cacheDir)).toEqual([`plan-${expected}.json`]);
	});

	test("a new T21.2 mode keys on its own authMode and never collides with a legacy one", async () => {
		const auth = { mode: "openai", apiKey: "sk-o" } as unknown as ClaudeAuth;
		const adapter = createEvalLlmAdapter({ auth, cacheDir, planners });
		await adapter.plan({ segments: [], totalSec: 5 });

		const legacyKey = goldenKey({
			passName: "plan",
			payload: { segments: [], totalSec: 5, promptVersion: 2 },
			authMode: "api-key",
			model: "",
			runIndex: 0,
		});
		const files = fs.readdirSync(cacheDir);
		expect(files).toHaveLength(1);
		expect(files[0]).not.toBe(`plan-${legacyKey}.json`);
		expect(files[0]).toStartWith("plan-");
	});
});
