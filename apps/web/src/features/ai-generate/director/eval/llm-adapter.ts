/**
 * Golden-footage eval, LLM seam (U4): make the Director's three planning passes
 * callable from bun with Dan's auth, a prompt-hash disk cache, and a hard
 * watchdog. This is the `DirectorLlmAdapter` the pure `buildDirectorProposals`
 * module expects — but instead of hitting the Next routes it calls the hf-bridge
 * planners (`planDirector`/`planRedundancy`/`planContext`) directly, node-side,
 * so the eval runs the SAME pipeline as the app without a running server (KTD2).
 *
 * Three properties (KTD5/KTD6):
 *  1. Cache — every response is keyed by sha256(passName, payload, auth mode,
 *     model, runIndex) and written under `.eval-cache/`. Re-scoring is free and
 *     byte-stable; `--runs N` caches each live pass under its own index.
 *  2. Watchdog — the planners have NO timeout in claude-code mode (a CLI spawn
 *     with no signal), so each pass is raced against a timer (default 600s,
 *     `EVAL_LLM_TIMEOUT_MS`) that fails the run loudly, naming the pass.
 *  3. Bounded retry — 2 attempts on transport errors, NONE on a watchdog timeout
 *     (a hung CLI won't recover; retrying just doubles the wait).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	planContext,
	planDirector,
	planDirectorVision,
	planRedundancy,
	type ClaudeAuth,
} from "@framecut/hf-bridge";
import type {
	DirectorContextRequest,
	DirectorContextResponse,
	DirectorLlmAdapter,
	DirectorPlanRequest,
	DirectorPlanResponse,
	DirectorRedundancyRequest,
	DirectorRedundancyResponse,
} from "../build-director-proposals";

/** Default per-pass watchdog: 10 minutes. Override with EVAL_LLM_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 600_000;

const CLI_MISSING_HELP =
	"The Claude CLI isn't available on this machine. Install it (npm i -g @anthropic-ai/claude-code) and sign in (`claude setup-token`), or re-run with `--auth api-key` and set ANTHROPIC_API_KEY.";

/** The four hf-bridge planner entry points, injectable so tests can stub them
 * without spawning the real CLI. */
export interface EvalPlanners {
	director: typeof planDirector;
	vision: typeof planDirectorVision;
	redundancy: typeof planRedundancy;
	context: typeof planContext;
}

const DEFAULT_PLANNERS: EvalPlanners = {
	director: planDirector,
	vision: planDirectorVision,
	redundancy: planRedundancy,
	context: planContext,
};

export interface EvalLlmAdapterOptions {
	auth: ClaudeAuth;
	/** Which live run this is (`--runs N`); varies the cache key so each pass is
	 * cached independently. Default 0. */
	runIndex?: number;
	/** Where responses are cached. Default `<cwd>/.eval-cache`. */
	cacheDir?: string;
	/** Per-pass watchdog in ms. Default EVAL_LLM_TIMEOUT_MS or 600000. */
	timeoutMs?: number;
	/** Model label folded into the cache key (the planners pick the real model). */
	model?: string;
	/** Transport-error retry attempts (never applied to a watchdog timeout). Default 2. */
	attempts?: number;
	/** Optional abort signal forwarded to the vision planner. */
	signal?: AbortSignal;
	/** Injectable planners (tests). Defaults to the real hf-bridge ones. */
	planners?: EvalPlanners;
}

/** Resolve the CLI `--auth` choice into a hf-bridge `ClaudeAuth`. */
export function resolveClaudeAuth({
	mode,
	apiKey,
}: {
	mode: "claude-code" | "api-key";
	apiKey?: string;
}): ClaudeAuth {
	if (mode === "api-key") {
		if (!apiKey) {
			throw new Error(
				"--auth api-key needs ANTHROPIC_API_KEY in the environment (export it or drop --auth to use claude-code).",
			);
		}
		return { mode: "api-key", apiKey };
	}
	return { mode: "claude-code" };
}

/**
 * Fail fast with the actionable CLI-missing message when claude-code mode is
 * selected but the `claude` binary isn't on PATH — mirrors hf-bridge's
 * CLI_MISSING_HELP so the eval reports the same fix, not a raw ENOENT deep in a
 * pass. `binary` is injectable so a test can point it at a name that can't exist.
 */
export function verifyClaudeCli(binary = "claude"): void {
	// RESOLVE the binary on PATH — don't run `claude --version`, which BOOTS the
	// CLI (project/MCP init) and can hang for many seconds inside a repo. `where`
	// (Windows) / `command -v` (posix) just check PATH and return instantly.
	const isWin = process.platform === "win32";
	const res = isWin
		? spawnSync("where", [binary], { encoding: "utf8", timeout: 5000 })
		: spawnSync("command", ["-v", binary], {
				encoding: "utf8",
				shell: true,
				timeout: 5000,
			});
	if (res.status === 0 && !res.error) return;
	throw new Error(CLI_MISSING_HELP);
}

function hashKey(parts: {
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

/** True for the watchdog-timeout error (never retried). */
function isWatchdogTimeout(e: unknown): boolean {
	return e instanceof Error && e.message.includes("watchdog");
}

/** Race a pass against a timer; the timer rejects (naming the pass) and is always
 * cleared so a resolved pass doesn't leave a dangling handle. */
async function withWatchdog<T>(
	passName: string,
	fn: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`Eval LLM pass "${passName}" exceeded the ${Math.round(timeoutMs / 1000)}s watchdog — the claude-code CLI likely hung (a child may linger; kill it manually). Set EVAL_LLM_TIMEOUT_MS to change the budget.`,
				),
			);
		}, timeoutMs);
	});
	try {
		return await Promise.race([fn(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Watchdog + bounded transport retry. Timeouts throw immediately. */
async function withRetryAndWatchdog<T>(
	passName: string,
	fn: () => Promise<T>,
	timeoutMs: number,
	attempts: number,
): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i < Math.max(1, attempts); i++) {
		try {
			return await withWatchdog(passName, fn, timeoutMs);
		} catch (e) {
			lastErr = e;
			if (isWatchdogTimeout(e)) throw e; // a hung CLI won't recover on retry
		}
	}
	throw lastErr;
}

/**
 * Build the eval's `DirectorLlmAdapter`. Each pass is disk-cached, watchdog-
 * bounded, and retried on transport errors. `plan` throws on failure (the
 * Director aborts); `redundancy`/`context` may throw and the pure pipeline falls
 * back — matching the in-app adapter's contract exactly.
 */
export function createEvalLlmAdapter(
	options: EvalLlmAdapterOptions,
): DirectorLlmAdapter {
	const {
		auth,
		runIndex = 0,
		cacheDir = path.join(process.cwd(), ".eval-cache"),
		timeoutMs = Number(process.env.EVAL_LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
		model = "",
		attempts = 2,
		signal,
		planners = DEFAULT_PLANNERS,
	} = options;

	async function cachedCall<T>(
		passName: string,
		payload: unknown,
		run: () => Promise<T>,
	): Promise<T> {
		const key = hashKey({
			passName,
			payload,
			authMode: auth.mode,
			model,
			runIndex,
		});
		const file = path.join(cacheDir, `${passName}-${key}.json`);
		if (fs.existsSync(file)) {
			return JSON.parse(fs.readFileSync(file, "utf8")) as T;
		}
		const result = await withRetryAndWatchdog(passName, run, timeoutMs, attempts);
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(file, JSON.stringify(result));
		return result;
	}

	return {
		async plan(input: DirectorPlanRequest): Promise<DirectorPlanResponse> {
			return cachedCall("plan", input, async () => {
				if (input.frames && input.frames.length > 0) {
					const { plan, usage, degraded } = await planners.vision({
						segments: input.segments,
						totalSec: input.totalSec,
						taste: input.taste,
						catalog: input.catalog,
						frames: input.frames,
						auth,
						signal,
					});
					return { plan, usage: usage ?? undefined, degraded };
				}
				const { plan, usage } = await planners.director({
					segments: input.segments,
					totalSec: input.totalSec,
					taste: input.taste,
					catalog: input.catalog,
					// Compression contract (U3): forward the target so the prompt actually
					// gains the block. The cache key already hashes the full input payload,
					// so a target change forces a fresh live call (never a stale response).
					compressionTarget: input.compressionTarget,
					auth,
				});
				return { plan, usage: usage ?? undefined, degraded: false };
			});
		},
		async redundancy(
			input: DirectorRedundancyRequest,
		): Promise<DirectorRedundancyResponse> {
			return cachedCall("redundancy", input, async () => {
				const { plan, usage } = await planners.redundancy({
					lines: input.lines,
					taste: input.taste,
					auth,
				});
				return { plan, usage };
			});
		},
		async context(
			input: DirectorContextRequest,
		): Promise<DirectorContextResponse> {
			return cachedCall("context", input, async () => {
				const { plan, usage } = await planners.context({
					lines: input.lines,
					taste: input.taste,
					auth,
				});
				return { plan, usage };
			});
		},
	};
}
