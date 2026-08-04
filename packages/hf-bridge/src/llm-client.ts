/**
 * LLM provider layer (T21.2): ONE dispatch for every schema-constrained or
 * free-text LLM call in hf-bridge, keyed on provider CAPABILITIES rather than
 * call site.
 *
 * Two transport families cover every auth mode:
 *  - Anthropic Messages (`api-key`): native json_schema, inline images, native
 *    tools. This is the default and the quality-reference config - the Director
 *    eval suite (G5) runs against Anthropic only.
 *  - OpenAI-compatible chat/completions (`custom`, `openai`, `xai-grok`,
 *    `groq-llm`): response_format json_object where supported, `extractJson`
 *    fallback always. The three named providers are CONFIGS over this one
 *    transport (a fixed base URL + default model), not new code paths.
 *  - The `claude-code` CLI is the degenerate tier: no images, no tools, no
 *    schema enforcement, so it gets the prompt + extractJson fallback and the
 *    `degraded` flag on multimodal asks.
 *
 * Non-Anthropic providers carry a "community quality" label in the UI until
 * they pass the four-fixture eval. Prompt-version constants stay
 * provider-agnostic: one prompt, many providers, measured on Anthropic.
 */

import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { resolveClaude } from "./renderer";
import type { ClaudeAuth } from "./types";

// --- Capability model ------------------------------------------------------

export type LlmAuthMode = ClaudeAuth["mode"];

/** What a provider tier can do through this layer. */
export interface LlmCapabilities {
	/** Server-side JSON-schema enforcement (Anthropic Structured Outputs). */
	jsonSchema: boolean;
	/** Accepts inline base64 images in a request. */
	images: boolean;
	/**
	 * Native tool/function calling in the shape the assistant edit turn needs.
	 * Only Anthropic is wired for native tools; every other mode answers tool
	 * turns through the prompt-instructed JSON fallback (the route builds it).
	 */
	tools: boolean;
}

export const LLM_CAPABILITIES: Record<LlmAuthMode, LlmCapabilities> = {
	"api-key": { jsonSchema: true, images: true, tools: true },
	"claude-code": { jsonSchema: false, images: false, tools: false },
	custom: { jsonSchema: false, images: true, tools: false },
	openai: { jsonSchema: false, images: true, tools: false },
	"xai-grok": { jsonSchema: false, images: true, tools: false },
	"groq-llm": { jsonSchema: false, images: false, tools: false },
};

/**
 * True for the Anthropic-backed modes (API key or the Claude Code CLI, which
 * runs Anthropic models). Everything else is "community quality" until it
 * passes the four-fixture Director eval measured on Anthropic.
 */
export function isAnthropicBacked(mode: LlmAuthMode): boolean {
	return mode === "api-key" || mode === "claude-code";
}

// --- Named OpenAI-compatible providers -------------------------------------

export type NamedOpenAiProviderMode = "openai" | "xai-grok" | "groq-llm";

export interface OpenAiCompatibleProviderConfig {
	/** Includes the version prefix, like a `custom` baseUrl. */
	baseUrl: string;
	defaultModel: string;
	displayName: string;
}

export const OPENAI_COMPATIBLE_PROVIDERS: Record<
	NamedOpenAiProviderMode,
	OpenAiCompatibleProviderConfig
> = {
	openai: {
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-5.4",
		displayName: "OpenAI",
	},
	"xai-grok": {
		baseUrl: "https://api.x.ai/v1",
		defaultModel: "grok-4.3",
		displayName: "xAI Grok",
	},
	"groq-llm": {
		baseUrl: "https://api.groq.com/openai/v1",
		defaultModel: "llama-3.3-70b-versatile",
		displayName: "Groq (Llama)",
	},
};

/** Connection triple for any OpenAI-compatible auth mode (null otherwise). */
export function resolveOpenAiConnection(
	auth: ClaudeAuth,
): { baseUrl: string; apiKey?: string; model: string } | null {
	if (auth.mode === "custom") {
		return { baseUrl: auth.baseUrl, apiKey: auth.apiKey, model: auth.model };
	}
	if (
		auth.mode === "openai" ||
		auth.mode === "xai-grok" ||
		auth.mode === "groq-llm"
	) {
		const config = OPENAI_COMPATIBLE_PROVIDERS[auth.mode];
		return {
			baseUrl: config.baseUrl,
			apiKey: auth.apiKey,
			model: auth.model?.trim() || config.defaultModel,
		};
	}
	return null;
}

// --- Shared pieces ----------------------------------------------------------

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
}

/** Map an Anthropic `usage` object to our TokenUsage (null when absent). */
export function normalizeAnthropicUsage(
	usage: { input_tokens?: number; output_tokens?: number } | undefined,
): TokenUsage | null {
	return usage
		? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
		: null;
}

/** Map an OpenAI-compatible `usage` object to our TokenUsage (null when absent). */
export function normalizeOpenAiUsage(
	usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): TokenUsage | null {
	return usage
		? {
				inputTokens: usage.prompt_tokens ?? 0,
				outputTokens: usage.completion_tokens ?? 0,
			}
		: null;
}

export function extractJson(text: string): unknown {
	const direct = text.trim();
	try {
		return JSON.parse(direct);
	} catch {
		const start = direct.indexOf("{");
		const end = direct.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return JSON.parse(direct.slice(start, end + 1));
		}
		throw new Error("Planner returned no parseable JSON");
	}
}

/** OpenAI-compatible chat-completions URL from a user-supplied base URL. */
export function customChatUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

// --- Anthropic Messages transport -------------------------------------------

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

async function planViaAnthropicSchema(
	prompt: string,
	apiKey: string,
	schema: object,
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	const res = await fetch(ANTHROPIC_MESSAGES_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		},
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 8000,
			thinking: { type: "adaptive" },
			output_config: {
				format: { type: "json_schema", schema },
			},
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
	const text = data.content?.find((b) => b.type === "text")?.text ?? "";
	const usage = normalizeAnthropicUsage(data.usage);
	return { raw: extractJson(text), usage };
}

// --- OpenAI-compatible transport ---------------------------------------------

/**
 * Schema-constrained ask via an OpenAI-compatible endpoint (`custom` or one of
 * the named providers). Asks for JSON via response_format where supported;
 * extractJson is the fallback for servers that ignore it.
 */
async function planViaOpenAiSchema(
	prompt: string,
	conn: { baseUrl: string; apiKey?: string; model: string },
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	const res = await fetch(customChatUrl(conn.baseUrl), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: conn.model,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.4,
			response_format: { type: "json_object" },
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Custom model error ${res.status}: ${body.slice(0, 500)}`);
	}
	const data = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const text = data.choices?.[0]?.message?.content ?? "";
	const usage = normalizeOpenAiUsage(data.usage);
	return { raw: extractJson(text), usage };
}

// --- claude-code CLI transport (the degenerate tier) --------------------------

/** Kill leash for the claude-code CLI spawn (round 12 U3/R4): a wedged CLI (a
 * hung network call, a login prompt waiting on a terminal that isn't there)
 * previously kept the child - and the whole Director run - alive forever. On
 * expiry the child is killed and the plan call rejects with a plain message. */
const CLAUDE_CLI_KILL_TIMEOUT_MS = 300_000;

/** Pure branch decision for the kill timer below, split out so it is
 * unit-testable without actually spawning anything. On Windows the CLI runs
 * through `shell: true` (resolveClaude in renderer.ts needs the shell to
 * resolve the bare `claude` command's `.cmd` shim via PATHEXT), which means
 * the spawned pid is cmd.exe, not the real claude/node process underneath
 * it. A plain `child.kill()` only reaps that cmd.exe wrapper and orphans the
 * real process, which keeps running the hung call. So on Windows we walk and
 * kill the whole process tree by pid instead. */
export function shouldTaskkillOnTimeout({
	platform,
	pid,
}: {
	platform: NodeJS.Platform;
	pid: number | undefined;
}): boolean {
	return platform === "win32" && pid != null;
}

function planViaClaudeCode(
	prompt: string,
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	return new Promise((resolve, reject) => {
		const { command, useShell } = resolveClaude();
		const child = spawn(command, ["-p", "--output-format", "json"], {
			shell: useShell,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let out = "";
		let err = "";
		// Kill timer (round 12 U3/R4, tree-kill added later): reject FIRST (so
		// the caller fails with the real reason, not a generic exit-code message
		// from the kill's close event), then kill the child. `timedOut` makes the
		// close handler a no-op after.
		let timedOut = false;
		const killTimer = setTimeout(() => {
			timedOut = true;
			reject(
				new Error(
					`The claude CLI did not respond within ${CLAUDE_CLI_KILL_TIMEOUT_MS / 60_000} minutes and was stopped. Check that the CLI works (run \`claude\` in a terminal), or switch Settings -> AI to an Anthropic API key.`,
				),
			);
			if (shouldTaskkillOnTimeout({ platform: process.platform, pid: child.pid })) {
				// Fire-and-forget: we already rejected above, so this is best-effort
				// cleanup and must never itself throw or reject anything.
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
		}, CLAUDE_CLI_KILL_TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (err += d.toString()));
		child.on("error", (e) => {
			clearTimeout(killTimer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(killTimer);
			if (timedOut) return; // already rejected; this close came from the kill
			// claude-code `--output-format json` reports API/auth errors in the STDOUT
			// JSON (`is_error` / `api_error_status` / `result`) - typically with a
			// NON-zero exit and EMPTY stderr. Parse stdout FIRST so we surface the real
			// reason (e.g. a 401 auth failure) instead of a bare "exited 1:".
			let wrapper: {
				result?: string;
				is_error?: boolean;
				api_error_status?: number;
				usage?: { input_tokens?: number; output_tokens?: number };
			} | null = null;
			try {
				wrapper = JSON.parse(out);
			} catch {
				wrapper = null;
			}

			if (wrapper?.is_error === true) {
				const status = wrapper.api_error_status;
				const detail =
					typeof wrapper.result === "string"
						? wrapper.result
						: `claude CLI error (exit ${code})`;
				const authHint =
					status === 401 || /authenticat|invalid auth|credential/i.test(detail)
						? " - the claude CLI is not signed in. Run `claude setup-token` (or `claude` then /login) in a terminal, or switch Settings → AI to an Anthropic API key."
						: "";
				reject(
					new Error(
						`Claude planning failed${status ? ` (API ${status})` : ""}: ${detail}${authHint}`,
					),
				);
				return;
			}

			if (code !== 0) {
				// A wiped/missing CLI binary surfaces as "not recognized"/ENOENT - point
				// at the escape hatch rather than a cryptic shell error.
				const hint = /not recognized|ENOENT|not found|cannot find/i.test(err)
					? " - the claude CLI isn't runnable (a failed update may have wiped its binary). Set FRAMECUT_CLAUDE to a working claude path, or restore the CLI."
					: "";
				reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 800)}${hint}`));
				return;
			}

			try {
				const text =
					typeof wrapper?.result === "string" ? wrapper.result : out;
				const usage = normalizeAnthropicUsage(wrapper?.usage);
				resolve({ raw: extractJson(text), usage });
			} catch (e) {
				reject(new Error(`Could not parse claude CLI output: ${String(e)}`));
			}
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

// --- The dispatch --------------------------------------------------------------

/**
 * Route a schema-constrained JSON ask to the connected backend. Anthropic gets
 * native json_schema; every OpenAI-compatible mode shares one transport;
 * claude-code is the degenerate prompt + extractJson tier.
 */
export function planJsonTransport(
	prompt: string,
	auth: ClaudeAuth,
	schema: object,
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	if (auth.mode === "api-key") {
		return planViaAnthropicSchema(prompt, auth.apiKey, schema);
	}
	const conn = resolveOpenAiConnection(auth);
	if (conn) {
		return planViaOpenAiSchema(prompt, conn);
	}
	return planViaClaudeCode(prompt);
}

// --- Multimodal dispatch (images + text) ---------------------------------------

/** Image media types the Anthropic Messages API accepts. */
export type MultimodalImageMediaType =
	| "image/jpeg"
	| "image/png"
	| "image/gif"
	| "image/webp";

/** A content block for a multimodal ask: a base64 image or a text run. */
export type MultimodalBlock =
	| { type: "image"; mediaType: MultimodalImageMediaType; dataBase64: string }
	| { type: "text"; text: string };

export interface MultimodalResult {
	raw: unknown;
	usage: TokenUsage | null;
	/** True when the backend can't take images and the call ran text-only. */
	degraded: boolean;
}

/**
 * Default vision model for BULK classification (cheap). Hard calls (the Director
 * plan) pass `model: "claude-opus-4-8"`. (KTD2/KTD3.)
 */
const DEFAULT_MULTIMODAL_MODEL = "claude-sonnet-4-6";

/**
 * Max images forwarded in one request - bounds the payload and the server's
 * compute window. Excess images are truncated with a logged warning, never
 * silently dropped (the caller's tiered gate should keep counts well under this).
 */
export const MAX_MULTIMODAL_IMAGES = 20;

interface PartitionedBlocks {
	images: Array<{ mediaType: string; dataBase64: string }>;
	/** All text blocks concatenated, in order. */
	text: string;
	/** True when images were truncated to fit MAX_MULTIMODAL_IMAGES. */
	truncated: boolean;
}

/**
 * Split blocks into a capped image list + concatenated text. Over the cap,
 * truncate (keeping the first N) and log a warning - never silently drop.
 */
export function partitionMultimodalBlocks(
	blocks: readonly MultimodalBlock[],
): PartitionedBlocks {
	const allImages = blocks.filter(
		(b): b is Extract<MultimodalBlock, { type: "image" }> => b.type === "image",
	);
	const text = blocks
		.filter((b): b is Extract<MultimodalBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
	const truncated = allImages.length > MAX_MULTIMODAL_IMAGES;
	if (truncated) {
		console.warn(
			`[hf-bridge] planMultimodal: ${allImages.length} images exceeds cap ${MAX_MULTIMODAL_IMAGES}; truncating to ${MAX_MULTIMODAL_IMAGES} (no silent drop).`,
		);
	}
	const images = allImages
		.slice(0, MAX_MULTIMODAL_IMAGES)
		.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }));
	return { images, text, truncated };
}

/** Anthropic Messages body: images BEFORE text, native Structured Outputs. */
export function buildAnthropicMultimodalBody({
	images,
	text,
	schema,
	model,
}: {
	images: Array<{ mediaType: string; dataBase64: string }>;
	text: string;
	schema: object;
	model?: string;
}): object {
	return {
		model: model ?? DEFAULT_MULTIMODAL_MODEL,
		max_tokens: 8000,
		thinking: { type: "adaptive" },
		output_config: { format: { type: "json_schema", schema } },
		messages: [
			{
				role: "user",
				content: [
					...images.map((img) => ({
						type: "image",
						source: {
							type: "base64",
							media_type: img.mediaType,
							data: img.dataBase64,
						},
					})),
					// Omit an empty text block - the Messages API rejects `text: ""`.
					...(text ? [{ type: "text", text }] : []),
				],
			},
		],
	};
}

/** OpenAI-compatible vision body: image_url data URIs before text. */
export function buildCustomMultimodalBody({
	images,
	text,
	model,
}: {
	images: Array<{ mediaType: string; dataBase64: string }>;
	text: string;
	model: string;
}): object {
	return {
		model,
		messages: [
			{
				role: "user",
				content: [
					...images.map((img) => ({
						type: "image_url",
						image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
					})),
					...(text ? [{ type: "text", text }] : []),
				],
			},
		],
		temperature: 0.4,
		response_format: { type: "json_object" },
	};
}

/**
 * SSRF guard for the user-supplied `custom` vision endpoint - the ONLY path that
 * forwards FOOTAGE FRAMES off-device, so it is the only one that needs the guard.
 * Mirrors `apps/web/.../api/broll/fetch/route.ts`: https only, no IP literals, no
 * `localhost`/`.local`/`.internal`. (Local LLM servers can't take footage frames
 * for this reason - use `api-key` for the visual Director.) Throws on reject.
 */
export function assertSafeMultimodalHost(baseUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error(`Invalid custom endpoint URL: ${baseUrl}`);
	}
	// Normalize before the checks: lowercase, strip a single trailing dot (the FQDN
	// form `localhost.`), and unwrap an IPv6 literal's brackets - `URL.hostname`
	// keeps them (e.g. `[::1]`) and `node:net` `isIP()` returns 0 for a bracketed
	// address, which would otherwise let IPv6 loopback / ULA / link-local / IPv4-
	// mapped literals slip past the IP-literal check.
	let host = parsed.hostname.toLowerCase();
	if (host.endsWith(".")) host = host.slice(0, -1);
	const ipLiteral =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (
		parsed.protocol !== "https:" ||
		isIP(ipLiteral) !== 0 ||
		host === "localhost" ||
		host === "localhost.localdomain" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		throw new Error(
			`Custom vision endpoint host not allowed (must be a public https host): ${host}`,
		);
	}
}

/**
 * Dispatch a multimodal (image+text) schema-constrained ask by capability.
 * Image-capable modes send the images (`api-key` via Anthropic Messages, the
 * OpenAI-compatible modes via image_url data URIs); image-less modes
 * (`claude-code`, and text-only providers like `groq-llm`) strip them and run
 * text-only with `degraded: true`. Accumulated `TokenUsage` rides on the result.
 */
export async function planMultimodal({
	blocks,
	auth,
	schema,
	model,
	signal,
}: {
	blocks: readonly MultimodalBlock[];
	auth: ClaudeAuth;
	schema: object;
	model?: string;
	/** Aborts the in-flight LLM request when a Director run is cancelled. */
	signal?: AbortSignal;
}): Promise<MultimodalResult> {
	if (signal?.aborted) throw new Error("Cancelled");
	const { images, text } = partitionMultimodalBlocks(blocks);

	if (auth.mode === "api-key") {
		const res = await fetch(ANTHROPIC_MESSAGES_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": auth.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			body: JSON.stringify(
				buildAnthropicMultimodalBody({ images, text, schema, model }),
			),
			signal,
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
		}
		const data = (await res.json()) as {
			content?: { type: string; text?: string }[];
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		// A 200 with a missing/empty content array (overloaded / refusal / streamed
		// shapes) must surface as extractJson's typed error, not a raw TypeError.
		const out = data.content?.find((b) => b.type === "text")?.text ?? "";
		return {
			raw: extractJson(out),
			usage: normalizeAnthropicUsage(data.usage),
			degraded: false,
		};
	}

	const conn = resolveOpenAiConnection(auth);
	if (conn) {
		if (!LLM_CAPABILITIES[auth.mode].images) {
			// Text-only provider (e.g. groq-llm): strip the frames, flag degraded.
			const { raw, usage } = await planViaOpenAiSchema(text, conn);
			return { raw, usage, degraded: true };
		}
		if (auth.mode === "custom") {
			// Guard the host BEFORE any fetch - no frame leaves until this passes.
			// (The named providers are fixed public https endpoints and need no guard.)
			assertSafeMultimodalHost(conn.baseUrl);
		}
		const res = await fetch(customChatUrl(conn.baseUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
			},
			body: JSON.stringify(
				buildCustomMultimodalBody({ images, text, model: model ?? conn.model }),
			),
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
		const out = data.choices?.[0]?.message?.content ?? "";
		return {
			raw: extractJson(out),
			usage: normalizeOpenAiUsage(data.usage),
			degraded: false,
		};
	}

	// claude-code CLI can't take inline images: strip them, run text-only.
	const { raw, usage } = await planViaClaudeCode(text);
	return { raw, usage, degraded: true };
}

// --- Free-text completion (composition authoring) -------------------------------

/**
 * One free-text completion (no schema): the HyperFrames composition author.
 * `api-key` uses Anthropic Messages; every OpenAI-compatible mode shares the
 * chat/completions transport. `claude-code` is rejected here on purpose - that
 * mode authors via the real HyperFrames CLI skill instead (authorViaSkill in
 * author-composition.ts), which applies the skill's layout knowledge.
 */
export async function chatTextCompletion({
	prompt,
	auth,
	maxTokens = 16000,
	temperature = 0.7,
	model,
	signal,
}: {
	prompt: string;
	auth: ClaudeAuth;
	maxTokens?: number;
	temperature?: number;
	/** Hard model override; defaults to claude-opus-4-8 / the provider default. */
	model?: string;
	signal?: AbortSignal;
}): Promise<{ text: string; usage: TokenUsage | null }> {
	if (auth.mode === "api-key") {
		const res = await fetch(ANTHROPIC_MESSAGES_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": auth.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			body: JSON.stringify({
				model: model ?? "claude-opus-4-8",
				max_tokens: maxTokens,
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
		return {
			text: data.content.find((b) => b.type === "text")?.text ?? "",
			usage: normalizeAnthropicUsage(data.usage),
		};
	}
	const conn = resolveOpenAiConnection(auth);
	if (conn) {
		const res = await fetch(customChatUrl(conn.baseUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: model ?? conn.model,
				messages: [{ role: "user", content: prompt }],
				temperature,
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
		return {
			text: data.choices?.[0]?.message?.content ?? "",
			usage: normalizeOpenAiUsage(data.usage),
		};
	}
	throw new Error(
		"chatTextCompletion does not support claude-code mode (composition authoring uses the HyperFrames skill there).",
	);
}
