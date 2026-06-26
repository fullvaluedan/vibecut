/**
 * Skill-as-producer: turn a compiled HyperFrames brief into a rendered
 * composition. In claude-code mode this drives the REAL `hyperframes` skill,
 * which AUTHORS index.html into the comp dir (Skill + file tools only, no
 * permission bypass) — so it applies the skill's layout/style/quality knowledge.
 * api-key/custom modes can't load Claude Code skills, so they fall back to an
 * inline format-rules prompt and the product writes the returned HTML. The comp
 * dir is then rendered by renderCompDir().
 *
 * This is what makes "RUN HYPERFRAMES" produce a CUSTOM graphic tailored to the
 * brief + the user's picked style, instead of a fixed template.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
	const compId = `authored-${randomUUID()}`;
	const compDir = path.join(generatedRoot(), compId);
	await mkdir(compDir, { recursive: true });
	const indexPath = path.join(compDir, "index.html");

	let usage: { inputTokens: number; outputTokens: number } | null = null;
	if (auth.mode === "claude-code") {
		// Drive the REAL hyperframes skill — it AUTHORS index.html into compDir,
		// applying the skill's layout/style/quality knowledge to the panel brief.
		await authorViaSkill({
			brief: prompt,
			compDir,
			width,
			height,
			durationSec,
			signal,
		});
	} else {
		// api-key / custom hit a raw chat API and can't load Claude Code skills,
		// so they fall back to the inline format rules + returned-HTML capture.
		const rules = FORMAT_RULES.replace(/__W__/g, String(width))
			.replace(/__H__/g, String(height))
			.replace(
				/__D__/g,
				String(Math.max(1, Math.round(durationSec * 10) / 10)),
			);
		const fullPrompt = `${rules}\n\nBRIEF:\n${prompt}`;
		const res =
			auth.mode === "api-key"
				? await authorViaApi(fullPrompt, auth.apiKey, signal)
				: await authorViaCustom(fullPrompt, auth, signal);
		usage = res.usage;
		const cleaned = stripToHtml(res.html);
		if (!/^\s*<(!doctype|html)/i.test(cleaned)) {
			throw new Error("The author did not return an HTML document.");
		}
		await writeFile(indexPath, cleaned, "utf8");
	}

	if (!existsSync(indexPath)) {
		throw new Error("Authoring did not produce an index.html composition.");
	}
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

/** Wrap the panel brief in a skill-triggering request for one overlay composition. */
function buildSkillBrief({
	width,
	height,
	durationSec,
	brief,
}: {
	width: number;
	height: number;
	durationSec: number;
	brief: string;
}): string {
	const d = Math.max(1, Math.round(durationSec * 10) / 10);
	return `Author ONE short HyperFrames overlay composition with the hyperframes skill. This is a TINY single graphic, NOT a multi-scene video, so SKIP the heavy workflow: no discovery, no prompt-expansion, no design-picker, no beat-direction, and no lint/inspect/validate/animation-map steps. Do NOT read extra reference files. Author the composition HTML DIRECTLY in ONE pass and write it to ./index.html in the CURRENT directory.

Composition rules: ${width}x${height}, ${d}s total, TRANSPARENT background (it overlays footage; no full-frame fill unless a selected full-frame style is meant to reframe the shot). The ROOT element MUST carry the FULL contract or the graphic renders BLANK — put it directly in <body> (no <template> wrapper) exactly as: <div data-composition-id="root" data-start="0" data-width="${width}" data-height="${height}" data-duration="${d}"> … </div>. data-start="0" is REQUIRED: without it the runtime never starts playback, so any entrance built with gsap.from(opacity:0) stays invisible and the render is empty. Build ONE paused GSAP timeline registered on window.__timelines["root"], and keep it deterministic (no Math.random or Date.now). Do NOT GSAP-animate transform/x/y on an element that is centered with a CSS transform (e.g. translateX(-50%)) — GSAP overwrites the whole transform and breaks the centering; animate a child wrapper, or use xPercent/top/left + autoAlpha. Use the user's selected assets/style below FAITHFULLY: if they named a style, match it, do not improvise a different look.

PLACEMENT (critical): this overlays a TALKING-HEAD video. Assume the SPEAKER occupies the CENTER third of the frame (roughly x from 33% to 67%). Place the graphic in a SAFE ZONE that does NOT cover the speaker: a lower third, a top band, or a side margin/column. NEVER put a large graphic dead-center over the speaker's face. A full-frame style (e.g. a grid/layout that reframes the shot) is the only exception.

INTENT: the graphic should HELP the viewer grasp the spoken point, not distract or interrupt. Keep it clean and minimal: short text (<= 5 words per line), clear hierarchy, on-brand with the selected style, high contrast against busy footage (a solid bar/box behind text, never a full-frame fill). Animate it IN, hold briefly, then animate it OUT within the ${d}s so it never lingers.

Write ./index.html now and stop. Do not run npx, render, lint, or init.

BRIEF:
${brief}`;
}

/**
 * Drive the REAL `hyperframes` Claude Code skill to author the composition. The
 * skill (loaded via the Skill tool) writes index.html into compDir, applying its
 * layout/style/quality knowledge to the brief. Only the Skill + file tools are
 * allowed (no Bash, no permission bypass), so it authors the file but never runs
 * the CLI/render itself — VibeCut renders the result. Resolves once index.html
 * exists; success is the WRITTEN file, not the exit code.
 */
function authorViaSkill({
	brief,
	compDir,
	width,
	height,
	durationSec,
	signal,
}: {
	brief: string;
	compDir: string;
	width: number;
	height: number;
	durationSec: number;
	signal?: AbortSignal;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Cancelled"));
			return;
		}
		const { command, useShell } = resolveClaude();
		const child = spawn(
			command,
			[
				"-p",
				"--allowedTools",
				"Skill",
				"Write",
				"Edit",
				"Read",
				"Glob",
				"Grep",
				"--max-turns",
				"8",
			],
			{
				// cwd = compDir so the skill's `./index.html` lands in the comp dir
				// (claude restricts writes to cwd without a permission bypass).
				cwd: compDir,
				shell: useShell,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, NO_COLOR: "1" },
			},
		);
		let out = "";
		let err = "";
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killTree(child);
			cleanup();
			reject(
				new Error("Authoring timed out — claude did not respond in time."),
			);
		}, AUTHOR_TIMEOUT_MS);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			killTree(child);
			cleanup();
			reject(new Error("Cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
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
			if (existsSync(path.join(compDir, "index.html"))) {
				resolve();
				return;
			}
			const authFail = /401|invalid auth|authenticat|credential/i.test(
				`${out}\n${err}`,
			);
			reject(
				new Error(
					code === 127 || CLI_MISSING.test(err)
						? CLI_MISSING_HELP
						: authFail
							? `Claude authoring failed (auth): the claude CLI is not signed in. Run \`claude setup-token\` (or \`claude\` then /login) in a terminal, or switch Settings → AI to an Anthropic API key.`
							: `The HyperFrames skill did not write a composition (claude exited ${code}): ${(out || err).slice(-800)}`,
				),
			);
		});
		child.stdin.write(buildSkillBrief({ width, height, durationSec, brief }));
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
