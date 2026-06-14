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
import { generatedRoot } from "./renderer";
import type { ClaudeAuth } from "./types";

const FORMAT_RULES = `You are authoring a HyperFrames video composition (HTML that renders to video). Output ONLY the raw contents of index.html — start with <!doctype html> and end with </html>. NO markdown code fences, NO explanation, NO preamble.

HyperFrames format rules (follow EXACTLY):
- Standalone composition: put a <div data-composition-id="root" data-width="__W__" data-height="__H__" data-start="0" data-duration="__D__"> DIRECTLY in <body> (NOT inside a <template>).
- html, body { margin:0; padding:0; background:transparent; } — this is a transparent OVERLAY (the footage shows through) UNLESS the brief explicitly asks for a full-frame background.
- Load GSAP once: <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
- Build ONE paused GSAP timeline and register it: window.__timelines = window.__timelines || {}; window.__timelines["root"] = tl;
- Deterministic ONLY: NO Math.random(), NO Date.now(). Animate only opacity, x, y, scale, rotation, color, backgroundColor.
- Use renderer-resolvable fonts (font-family: Arial, Helvetica, Georgia, "Times New Roman", sans-serif/serif). Text >= 40px. Put a solid bar/box BEHIND overlay text for contrast (not a full-frame fill).
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
}: {
	/** The compiled HyperFrames brief (panel selections + scope + transcript). */
	prompt: string;
	fps: number;
	width: number;
	height: number;
	durationSec: number;
	auth: ClaudeAuth;
}): Promise<AuthoredComposition> {
	const rules = FORMAT_RULES.replace(/__W__/g, String(width))
		.replace(/__H__/g, String(height))
		.replace(/__D__/g, String(Math.max(1, Math.round(durationSec * 10) / 10)));
	const fullPrompt = `${rules}\n\nBRIEF:\n${prompt}`;

	const { html, usage } =
		auth.mode === "api-key"
			? await authorViaApi(fullPrompt, auth.apiKey)
			: await authorViaClaudeCode(fullPrompt);

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

function authorViaClaudeCode(
	prompt: string,
): Promise<{ html: string; usage: null }> {
	return new Promise((resolve, reject) => {
		const child = spawn("claude", ["-p"], {
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let out = "";
		let err = "";
		// Don't let a hung CLI hold the request for the full route maxDuration.
		const timer = setTimeout(() => {
			child.kill();
			reject(
				new Error("Authoring timed out — claude did not respond in time."),
			);
		}, AUTHOR_TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (err += d.toString()));
		child.on("error", (e) => {
			clearTimeout(timer);
			const msg = e instanceof Error ? e.message : String(e);
			reject(new Error(CLI_MISSING.test(msg) ? CLI_MISSING_HELP : msg));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
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
			max_tokens: 8000,
			messages: [{ role: "user", content: prompt }],
		}),
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
