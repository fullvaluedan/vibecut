import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Codex CLI backend ("ChatGPT login") — the OpenAI counterpart of the
 * claude-code path in author.ts. The user installs the Codex CLI and signs in
 * once with `codex login` (ChatGPT OAuth, browser flow); VibeCut then drives
 * `codex exec` non-interactively per AI request. Credentials never enter the
 * browser or any project file — they live in the CLI's own auth store
 * (`~/.codex/auth.json`), which makes this the most device-local of all
 * connection modes. Verified against the Codex CLI reference
 * (developers.openai.com/codex/cli/reference) on 2026-09-08.
 *
 * This module stays dependency-free (node builtins only) and imports nothing
 * from author.ts, so author.ts can import from here without a cycle.
 */

/** Same leash the claude-code path uses: 5 minutes, then kill. */
export const CODEX_CLI_KILL_TIMEOUT_MS = 300_000;

/**
 * Mirrors `resolveClaude` in renderer.ts: FRAMECUT_CODEX overrides the binary
 * (escape hatch for non-PATH installs), the bare command runs through the
 * shell so Windows resolves the npm `.cmd` shim via PATHEXT.
 */
export function resolveCodex(): { command: string; useShell: boolean } {
	const override = process.env.FRAMECUT_CODEX?.trim();
	return override
		? { command: override, useShell: false }
		: { command: "codex", useShell: true };
}

/**
 * Pure argv builder for a non-interactive, sandboxed, ephemeral exec run.
 * Kept separate from the spawn so the flag contract is unit-testable.
 *
 * - `--sandbox read-only`: the model only needs to answer; it never writes.
 * - `--skip-git-repo-check`: the temp cwd is not (necessarily) a repo.
 * - `--ephemeral`: don't persist a session rollout file per AI request
 *   (otherwise every VibeCut call would pile files into ~/.codex/sessions).
 * - `--output-schema`: Codex validates its final response against this JSON
 *   Schema file — the closest exec-mode equivalent of structured output.
 * - `--output-last-message`: final agent message lands in a file, so we never
 *   parse human-readable progress noise off stdout.
 */
export function buildCodexExecArgs({
	schemaPath,
	outputPath,
	model,
}: {
	schemaPath?: string;
	outputPath: string;
	model?: string;
}): string[] {
	return [
		"exec",
		"--sandbox",
		"read-only",
		"--skip-git-repo-check",
		"--ephemeral",
		...(model ? ["-m", model] : []),
		...(schemaPath ? ["--output-schema", schemaPath] : []),
		"--output-last-message",
		outputPath,
		// `-` = read the full prompt from stdin (documented sentinel). Big
		// prompts (transcript tables, HTML briefs) must never ride on the
		// command line — Windows caps a single arg well below their size.
		"-",
	];
}

/** Stderr fragments that mean "the CLI is there but nobody is signed in". */
const AUTH_ERROR_RE = /not logged in|logged?[\s-]?out|need to (log|sign) in|login required|unauthorized|no credentials/i;

/** Pure: turn raw CLI failure text into the actionable hint (unit-tested). */
export function codexAuthHint(err: string): string {
	return AUTH_ERROR_RE.test(err)
		? " — the Codex CLI is not signed in. Run `codex login` in a terminal and sign in with your ChatGPT account, then retry."
		: "";
}

/** Pure: ENOENT-style "binary missing" detection for the install hint. */
export function codexMissingHint(err: string): string {
	return /not recognized|ENOENT|not found|cannot find/i.test(err)
		? " — the Codex CLI isn't installed or isn't on PATH. Install it (`npm i -g @openai/codex`) or set FRAMECUT_CODEX to a working codex path."
		: "";
}

/**
 * Pure branch decision for the kill timer — same Windows tree-kill rationale
 * as `shouldTaskkillOnTimeout` in author.ts (shell-spawned pid is cmd.exe; a
 * plain kill orphans the real process). Duplicated as a one-liner instead of
 * imported to keep this module cycle-free from author.ts; the behavioural
 * tests live with the author.ts copy.
 */
function shouldTaskkillOnTimeout(pid: number | undefined): boolean {
	return process.platform === "win32" && pid != null;
}

export interface CodexRunResult {
	/** The agent's final message (from --output-last-message). */
	final: string;
}

/**
 * One `codex exec` run: prompt via stdin, final message captured to a temp
 * file. Reject-then-kill on timeout (mirrors planViaClaudeCode), abortable.
 */
export function runCodexPrompt({
	prompt,
	schema,
	model,
	timeoutMs = CODEX_CLI_KILL_TIMEOUT_MS,
	signal,
}: {
	prompt: string;
	/** Optional JSON Schema the final response must conform to. */
	schema?: object;
	model?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<CodexRunResult> {
	if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
	return new Promise<CodexRunResult>((resolve, reject) => {
		let workDir: string | null = null;
		let timedOut = false;
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanupSignal();
			cleanupWorkDir();
			fn();
		};

		const onAbort = () => {
			killChild();
			done(() => reject(new Error("Cancelled")));
		};
		const cleanupSignal = () => {
			signal?.removeEventListener("abort", onAbort);
		};

		// Single settle funnel: runs the settle fn exactly once, then removes
		// the abort listener and deletes the temp dir (which holds the schema
		// and the output file, so it MUST outlive the codex process — cleanup
		// only ever happens here, never while the child is running).
		const cleanupWorkDir = () => {
			if (workDir) {
				const dir = workDir;
				workDir = null;
				void rm(dir, { recursive: true, force: true }).catch(() => {});
			}
		};

		const { command, useShell } = resolveCodex();

		let child: ReturnType<typeof spawn> | null = null;
		const killChild = () => {
			if (!child) return;
			if (shouldTaskkillOnTimeout(child.pid)) {
				try {
					spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]).on(
						"error",
						() => {},
					);
				} catch {
					child.kill();
				}
			} else {
				child.kill();
			}
		};

		(async () => {
			try {
				workDir = await mkdtemp(path.join(tmpdir(), "framecut-codex-"));
				let schemaPath: string | undefined;
				if (schema) {
					schemaPath = path.join(workDir, "schema.json");
					await writeFile(schemaPath, JSON.stringify(schema), "utf8");
				}
				const outputPath = path.join(workDir, "final-message.txt");
				const args = buildCodexExecArgs({ schemaPath, outputPath, model });

				child = spawn(command, args, {
					shell: useShell,
					cwd: workDir,
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env, NO_COLOR: "1" },
				});
				let out = "";
				let err = "";
				const killTimer = setTimeout(() => {
					timedOut = true;
					killChild();
					done(
						() =>
							reject(
								new Error(
									`The Codex CLI did not respond within ${Math.round(timeoutMs / 60_000)} minutes and was stopped. Check that it works (\`codex\` in a terminal), or switch Settings → AI to another connection.`,
								),
							),
					);
				}, timeoutMs);

				child.stdout?.on("data", (d) => (out += d.toString()));
				child.stderr?.on("data", (d) => (err += d.toString()));
				child.on("error", (e) => {
					clearTimeout(killTimer);
					done(() => reject(e));
				});
				child.on("close", (code) => {
					clearTimeout(killTimer);
					if (timedOut) return; // already rejected; close came from the kill
					if (signal?.aborted) return; // abort path already rejected
					if (code !== 0) {
						const text = `${err}\n${out}`.slice(0, 800);
						done(
							() =>
								reject(
									new Error(
										`codex CLI exited ${code}: ${text}${codexAuthHint(text)}${codexMissingHint(text)}`,
									),
								),
						);
						return;
					}
					readFile(outputPath, "utf8")
						.then((final) => {
							const trimmed = final.trim();
							if (!trimmed) {
								done(
									() =>
										reject(
											new Error(
												`codex CLI returned an empty response. ${err.slice(0, 300)}`,
											),
										),
								);
								return;
							}
							done(() => resolve({ final: trimmed }));
						})
						.catch((e) => {
							done(() =>
								reject(
									new Error(
										`Could not read codex CLI output: ${String(e).slice(0, 300)}`,
									),
								),
							);
						});
				});
				signal?.addEventListener("abort", onAbort, { once: true });
				child.stdin?.write(prompt);
				child.stdin?.end();
			} catch (e) {
				done(() => reject(e instanceof Error ? e : new Error(String(e))));
			}
		})();
	});
}

/** `codex login status` — exit 0 means credentials exist (per CLI reference). */
export function codexLoginStatus(): Promise<{
	installed: boolean;
	loggedIn: boolean;
	detail: string;
}> {
	return new Promise((resolve) => {
		const { command, useShell } = resolveCodex();
		let out = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, ["login", "status"], {
				shell: useShell,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, NO_COLOR: "1" },
			});
		} catch (e) {
			resolve({ installed: false, loggedIn: false, detail: String(e) });
			return;
		}
		const timer = setTimeout(() => child.kill(), 15_000);
		child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
		child.on("error", (e: Error) => {
			clearTimeout(timer);
			resolve({
				installed: false,
				loggedIn: false,
				detail: String(e).slice(0, 120),
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const detail = out.split(/\r?\n/).find(Boolean)?.slice(0, 160) ?? "";
			const missing = /not recognized|ENOENT|not found|cannot find/i.test(out);
			resolve({
				installed: !missing,
				loggedIn: code === 0 && !missing,
				detail: missing
					? "codex command not found"
					: detail || `exit ${code ?? "null"}`,
			});
		});
	});
}

/**
 * Agentic codex run for composition authoring: `--sandbox workspace-write`
 * with cwd set to the comp dir, so the agent may write ./index.html (the
 * deliverable). Success = exit 0; the CALLER checks the written file, so a
 * missing file with exit 0 still surfaces as a compose failure there. The
 * prompt rides stdin (`-` sentinel), the agent's final chat message is
 * discarded, no schema (the contract is the written file, not a JSON reply).
 */
export function runCodexAgent({
	prompt,
	cwd,
	model,
	timeoutMs = CODEX_CLI_KILL_TIMEOUT_MS,
	signal,
}: {
	prompt: string;
	cwd: string;
	model?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
	return new Promise<void>((resolve, reject) => {
		const { command, useShell } = resolveCodex();
		const args = [
			"exec",
			"--sandbox",
			"workspace-write",
			"--skip-git-repo-check",
			"--ephemeral",
			...(model ? ["-m", model] : []),
			"-",
		];
		let settled = false;
		let timedOut = false;
		const child = spawn(command, args, {
			cwd,
			shell: useShell,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let out = "";
		let err = "";
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};
		const killTree = () => {
			const pid = child.pid;
			if (pid == null) {
				child.kill();
				return;
			}
			try {
				if (process.platform === "win32") {
					spawn("taskkill", ["/pid", String(pid), "/t", "/f"]).on(
						"error",
						() => {},
					);
				} else {
					process.kill(-pid, "SIGKILL");
				}
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
			settle(() =>
				reject(
					new Error(
						"Authoring timed out — the Codex CLI did not respond in time.",
					),
				),
			);
		}, timeoutMs);
		const onAbort = () => {
			killTree();
			settle(() => reject(new Error("Cancelled")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.on("error", () => {});
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (err += d.toString()));
		child.on("error", (e) => {
			clearTimeout(timer);
			settle(() => reject(e));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return; // timeout already rejected
			const text = `${err}\n${out}`.slice(0, 800);
			if (code !== 0) {
				settle(() =>
					reject(
						new Error(
							`codex CLI exited ${code}: ${text}${codexAuthHint(text)}${codexMissingHint(text)}`,
						),
					),
				);
				return;
			}
			settle(() => resolve());
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}
