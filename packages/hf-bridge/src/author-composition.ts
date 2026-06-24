/**
 * Skill-as-producer: turn a compiled HyperFrames prompt into a rendered
 * composition by asking Claude to AUTHOR the composition HTML (text output —
 * the same safe pattern as the planner; Claude never writes files, the product
 * does). The returned comp dir is then rendered by renderCompDir().
 *
 * This is what makes "RUN HYPERFRAMES on this clip" produce a CUSTOM graphic
 * tailored to the brief, instead of a fixed template.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generatedRoot, resolveClaude } from "./renderer";
import { customChatUrl } from "./author";
import type { ClaudeAuth } from "./types";

const FORMAT_RULES = `You are authoring a HyperFrames video composition (HTML that renders to video). Output ONLY the raw contents of index.html — start with <!doctype html> and end with </html>. NO markdown code fences, NO explanation, NO preamble.

HyperFrames format rules (follow EXACTLY):
- Standalone composition: put a <div data-composition-id="root" data-width="__W__" data-height="__H__" data-start="0" data-duration="__D__"> DIRECTLY in <body> (NOT inside a <template>).
- html, body { margin:0; padding:0; background:transparent; } — this is a transparent OVERLAY (the footage shows through) UNLESS the brief explicitly asks for a full-frame background.
- Load GSAP once: <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
- Build ONE paused GSAP timeline and register it: window.__timelines = window.__timelines || {}; window.__timelines["root"] = tl;
- Deterministic ONLY: NO Math.random(), NO Date.now(). Animate only opacity, x, y, scale, rotation, color, backgroundColor.
- Use renderer-resolvable fonts (font-family: Arial, Helvetica, Georgia, "Times New Roman", sans-serif/serif). Text >= 40px. Put a solid bar/box BEHIND overlay text for contrast (not a full-frame fill).
- If the brief asks for multiple graphics, give EACH its own time segment within [0, __D__], stagger their start times across the FULL duration (never cluster them all at the start), and keep only one or two on screen at a time.
- Total duration is __D__ seconds; keep all animation within [0, __D__].`;

export interface AuthoredComposition {
	compId: string;
	compDir: string;
	usage: { inputTokens: number; outputTokens: number } | null;
}

export async function authorComposition({
	prompt,
	fps,
	width,
	height,
	durationSec,
	auth,
	signal,
}: {
	/** The compiled HyperFrames brief (panel selections + scope + transcript). */
	prompt: string;
	fps: number;
	width: number;
	height: number;
	durationSec: number;
	auth: ClaudeAuth;
	/**
	 * Aborts the author step. For claude-code mode this KILLS the spawned
	 * `claude -p` process tree (the long pole, ~30–90s); for api-key mode it
	 * aborts the outbound fetch. Wired from the route's `req.signal`, so a
	 * client cancel (or disconnect) stops the model call server-side.
	 */
	signal?: AbortSignal;
}): Promise<AuthoredComposition> {
	const rules = FORMAT_RULES.replace(/__W__/g, String(width))
		.replace(/__H__/g, String(height))
		.replace(/__D__/g, String(Math.max(1, Math.round(durationSec * 10) / 10)));
	const fullPrompt = `${rules}\n\nBRIEF:\n${prompt}`;

	const { html, usage } =
		auth.mode === "api-key"
			? await authorViaApi(fullPrompt, auth.apiKey, signal)
			: auth.mode === "custom"
				? await authorViaCustom(fullPrompt, auth, signal)
				: await authorViaClaudeCode(fullPrompt, signal);

	const cleaned = stripToHtml(html);
	if (!/^\s*<(!doctype|html)/i.test(cleaned)) {
		throw new Error("The author did not return an HTML document.");
	}

	const compId = `authored-${randomUUID()}`;
	const compDir = path.join(generatedRoot(), compId);
	await mkdir(compDir, { recursive: true });
	await writeFile(path.join(compDir, "index.html"), cleaned, "utf8");
	await writeFile(
		path.join(compDir, "framecut.json"),
		JSON.stringify({ fps }),
		"utf8",
	);
	return { compId, compDir, usage };
}

/** Strip markdown fences / preamble so only the HTML document remains. */
function stripToHtml(s: string): string {
	let t = s.trim();
	if (t.startsWith("```")) {
		t = t
			.replace(/^```[a-zA-Z]*\s*/, "")
			.replace(/```\s*$/, "")
			.trim();
	}
	const i = t.search(/<!doctype html>|<html[\s>]/i);
	if (i > 0) t = t.slice(i);
	return t.trim();
}

const AUTHOR_TIMEOUT_MS = 150_000;
const CLI_MISSING = /not found|is not recognized|ENOENT|command not found/i;
const CLI_MISSING_HELP =
	"The Claude CLI isn't available on this machine. Install it (npm i -g @anthropic-ai/claude-code) or switch to API-key mode and add an Anthropic key in Settings → AI.";

/**
 * Kill the WHOLE process tree of a `shell:true` spawn, not just the shell.
 * `child.kill()` only reaps the cmd.exe / sh wrapper, leaving the actual
 * `claude` (→ node) child running the model call. So:
 *  - win32: taskkill /T walks and force-kills the tree by pid.
 *  - posix: the child was spawned `detached` (its own process group, pgid ===
 *    pid), so a negative pid signals the whole group in one shot.
 * Both fall back to a plain kill if the tree kill can't be issued.
 */
function killTree(child: ReturnType<typeof spawn>): void {
	const pid = child.pid;
	if (pid == null) return;
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
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
}

function authorViaClaudeCode(
	prompt: string,
	signal?: AbortSignal,
): Promise<{ html: string; usage: null }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Cancelled"));
			return;
		}
		const { command, useShell } = resolveClaude();
		const child = spawn(command, ["-p"], {
			shell: useShell,
			// posix: own process group so killTree can signal the whole tree.
			// win32: never detach (it would pop a new console window) — taskkill
			// /T handles the tree there instead.
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let out = "";
		let err = "";
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		// Don't let a hung CLI hold the request for the full route maxDuration.
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killTree(child);
			cleanup();
			reject(
				new Error("Authoring timed out — claude did not respond in time."),
			);
		}, AUTHOR_TIMEOUT_MS);
		// Client cancel / disconnect (route forwards req.signal) — kill the model
		// call instead of letting it run to completion unobserved.
		const onAbort = () => {
			if (settled) return;
			settled = true;
			killTree(child);
			cleanup();
			reject(new Error("Cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		// After killTree the stdin pipe can emit a late EPIPE; swallow it so it
		// never surfaces as an unhandled 'error' that takes down the dev server.
		child.stdin.on("error", () => {});
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (err += d.toString()));
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			cleanup();
			const msg = e instanceof Error ? e.message : String(e);
			reject(new Error(CLI_MISSING.test(msg) ? CLI_MISSING_HELP : msg));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (code !== 0) {
				reject(
					new Error(
						code === 127 || CLI_MISSING.test(err)
							? CLI_MISSING_HELP
							: `claude CLI exited ${code}: ${err.slice(0, 800)}`,
					),
				);
				return;
			}
			resolve({ html: out, usage: null });
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

async function authorViaApi(
	prompt: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{
	html: string;
	usage: { inputTokens: number; outputTokens: number } | null;
}> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: "claude-opus-4-8",
			// Authored comps can be a dense, multi-graphic HTML document — give
			// the api-key path headroom so a rich composition isn't truncated.
			max_tokens: 16000,
			messages: [{ role: "user", content: prompt }],
		}),
		signal,
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
	}
	const data = (await res.json()) as {
		content: { type: string; text?: string }[];
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	const html = data.content.find((b) => b.type === "text")?.text ?? "";
	const usage = data.usage
		? {
				inputTokens: data.usage.input_tokens ?? 0,
				outputTokens: data.usage.output_tokens ?? 0,
			}
		: null;
	return { html, usage };
}

/**
 * Author via a user-supplied OpenAI-compatible endpoint (Ollama, LM Studio, a
 * self-hosted Nous-Hermes server, etc.). No response_format here — we want the
 * raw HTML document back, not JSON. The signal aborts the outbound request.
 */
async function authorViaCustom(
	prompt: string,
	conn: { baseUrl: string; apiKey?: string; model: string },
	signal?: AbortSignal,
): Promise<{
	html: string;
	usage: { inputTokens: number; outputTokens: number } | null;
}> {
	const res = await fetch(customChatUrl(conn.baseUrl), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: conn.model,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.7,
		}),
		signal,
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Custom model error ${res.status}: ${body.slice(0, 500)}`);
	}
	const data = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const html = data.choices?.[0]?.message?.content ?? "";
	const usage = data.usage
		? {
				inputTokens: data.usage.prompt_tokens ?? 0,
				outputTokens: data.usage.completion_tokens ?? 0,
			}
		: null;
	return { html, usage };
}
