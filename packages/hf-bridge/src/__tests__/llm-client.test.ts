import { afterEach, describe, expect, test } from "bun:test";

import {
	LLM_CAPABILITIES,
	OPENAI_COMPATIBLE_PROVIDERS,
	isAnthropicBacked,
	resolveOpenAiConnection,
	planJsonTransport,
	planMultimodal,
	chatTextCompletion,
	customChatUrl,
} from "../llm-client";
import type { ClaudeAuth } from "../types";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Capture {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function stubFetchJson(payload: unknown, status = 200): { calls: Capture[] } {
	const calls: Capture[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init?.body ?? "{}")),
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { calls };
}

const openAiReply = (text: string) => ({
	choices: [{ message: { content: text } }],
	usage: { prompt_tokens: 7, completion_tokens: 3 },
});

describe("capability model + provider configs", () => {
	test("every auth mode has a capability entry; only api-key has the full tier", () => {
		expect(LLM_CAPABILITIES["api-key"]).toEqual({
			jsonSchema: true,
			images: true,
			tools: true,
		});
		expect(LLM_CAPABILITIES["claude-code"]).toEqual({
			jsonSchema: false,
			images: false,
			tools: false,
		});
		expect(LLM_CAPABILITIES["groq-llm"].images).toBe(false); // text-only model
		expect(LLM_CAPABILITIES["openai"].images).toBe(true);
		expect(LLM_CAPABILITIES["xai-grok"].images).toBe(true);
	});

	test("Anthropic-backed modes vs community-quality modes", () => {
		expect(isAnthropicBacked("api-key")).toBe(true);
		expect(isAnthropicBacked("claude-code")).toBe(true);
		expect(isAnthropicBacked("custom")).toBe(false);
		expect(isAnthropicBacked("openai")).toBe(false);
		expect(isAnthropicBacked("xai-grok")).toBe(false);
		expect(isAnthropicBacked("groq-llm")).toBe(false);
	});

	test("named providers are configs over the OpenAI-compatible transport", () => {
		expect(OPENAI_COMPATIBLE_PROVIDERS.openai.baseUrl).toBe(
			"https://api.openai.com/v1",
		);
		expect(OPENAI_COMPATIBLE_PROVIDERS["xai-grok"].baseUrl).toBe(
			"https://api.x.ai/v1",
		);
		expect(OPENAI_COMPATIBLE_PROVIDERS["groq-llm"].baseUrl).toBe(
			"https://api.groq.com/openai/v1",
		);
		for (const config of Object.values(OPENAI_COMPATIBLE_PROVIDERS)) {
			expect(config.defaultModel.length).toBeGreaterThan(0);
			expect(config.displayName.length).toBeGreaterThan(0);
		}
	});
});

describe("resolveOpenAiConnection", () => {
	test("custom passes baseUrl/model through, key optional", () => {
		expect(
			resolveOpenAiConnection({
				mode: "custom",
				baseUrl: "http://localhost:11434/v1",
				model: "hermes-3",
			}),
		).toEqual({
			baseUrl: "http://localhost:11434/v1",
			apiKey: undefined,
			model: "hermes-3",
		});
	});

	test("named providers resolve fixed baseUrl + default model", () => {
		expect(
			resolveOpenAiConnection({ mode: "openai", apiKey: "sk-o" }),
		).toEqual({
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-o",
			model: OPENAI_COMPATIBLE_PROVIDERS.openai.defaultModel,
		});
		expect(
			resolveOpenAiConnection({ mode: "xai-grok", apiKey: "xai-k" }),
		).toEqual({
			baseUrl: "https://api.x.ai/v1",
			apiKey: "xai-k",
			model: OPENAI_COMPATIBLE_PROVIDERS["xai-grok"].defaultModel,
		});
		expect(
			resolveOpenAiConnection({ mode: "groq-llm", apiKey: "gsk" }),
		).toEqual({
			baseUrl: "https://api.groq.com/openai/v1",
			apiKey: "gsk",
			model: "llama-3.3-70b-versatile",
		});
	});

	test("a model override wins over the provider default", () => {
		expect(
			resolveOpenAiConnection({
				mode: "openai",
				apiKey: "sk-o",
				model: "gpt-custom",
			})?.model,
		).toBe("gpt-custom");
	});

	test("anthropic modes and claude-code are not OpenAI-compatible", () => {
		expect(resolveOpenAiConnection({ mode: "api-key", apiKey: "k" })).toBeNull();
		expect(resolveOpenAiConnection({ mode: "claude-code" })).toBeNull();
	});
});

describe("planJsonTransport - request shaping", () => {
	test("api-key: Anthropic Messages with native json_schema", async () => {
		const { calls } = stubFetchJson({
			content: [{ type: "text", text: '{"items":[]}' }],
			usage: { input_tokens: 5, output_tokens: 2 },
		});
		const res = await planJsonTransport(
			"plan",
			{ mode: "api-key", apiKey: "sk-ant" },
			{ type: "object" },
		);
		expect(res.raw).toEqual({ items: [] });
		expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
		expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
		expect(calls[0].headers["x-api-key"]).toBe("sk-ant");
		expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
		expect(calls[0].body.model).toBe("claude-opus-4-8");
		expect(
			(calls[0].body.output_config as { format: { type: string } }).format.type,
		).toBe("json_schema");
	});

	const openAiModes: Array<[ClaudeAuth, string, string]> = [
		[
			{ mode: "openai", apiKey: "sk-o" },
			"https://api.openai.com/v1/chat/completions",
			OPENAI_COMPATIBLE_PROVIDERS.openai.defaultModel,
		],
		[
			{ mode: "xai-grok", apiKey: "xai-k" },
			"https://api.x.ai/v1/chat/completions",
			OPENAI_COMPATIBLE_PROVIDERS["xai-grok"].defaultModel,
		],
		[
			{ mode: "groq-llm", apiKey: "gsk" },
			"https://api.groq.com/openai/v1/chat/completions",
			"llama-3.3-70b-versatile",
		],
		[
			{ mode: "custom", baseUrl: "http://localhost:11434/v1", model: "hermes-3" },
			"http://localhost:11434/v1/chat/completions",
			"hermes-3",
		],
	];

	for (const [auth, url, model] of openAiModes) {
		test(`${auth.mode}: OpenAI-compatible chat/completions shaping`, async () => {
			const { calls } = stubFetchJson(openAiReply('{"items":[]}'));
			const res = await planJsonTransport("plan", auth, { type: "object" });
			expect(res.raw).toEqual({ items: [] });
			expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
			expect(calls[0].url).toBe(url);
			expect(calls[0].body.model).toBe(model);
			expect(calls[0].body.response_format).toEqual({ type: "json_object" });
			const key =
				auth.mode === "custom"
					? undefined
					: (auth as { apiKey: string }).apiKey;
			if (key) expect(calls[0].headers.authorization).toBe(`Bearer ${key}`);
			else expect(calls[0].headers.authorization).toBeUndefined();
		});
	}

	test("model override is forwarded for named providers", async () => {
		const { calls } = stubFetchJson(openAiReply("{}"));
		await planJsonTransport(
			"p",
			{ mode: "groq-llm", apiKey: "gsk", model: "llama-4-scout" },
			{},
		);
		expect(calls[0].body.model).toBe("llama-4-scout");
	});

	test("extractJson fallback: prose around the JSON still parses", async () => {
		stubFetchJson(openAiReply('Here you go:\n{"items":[1]}\nHope that helps'));
		const res = await planJsonTransport(
			"p",
			{ mode: "openai", apiKey: "sk-o" },
			{},
		);
		expect(res.raw).toEqual({ items: [1] });
	});

	test("an OpenAI-compatible transport failure surfaces a typed error", async () => {
		globalThis.fetch = (async () =>
			new Response("down", { status: 502 })) as unknown as typeof fetch;
		await expect(
			planJsonTransport("p", { mode: "xai-grok", apiKey: "k" }, {}),
		).rejects.toThrow(/Custom model error 502/);
	});
});

describe("planMultimodal - capability-tier degradation", () => {
	const blocks = [
		{ type: "image" as const, mediaType: "image/jpeg" as const, dataBase64: "FRAME" },
		{ type: "text" as const, text: "the director prompt" },
	];

	test("openai: sends image_url data URIs, not degraded", async () => {
		const { calls } = stubFetchJson(openAiReply('{"role":"a-roll"}'));
		const res = await planMultimodal({
			blocks,
			auth: { mode: "openai", apiKey: "sk-o" },
			schema: {},
		});
		expect(res.degraded).toBe(false);
		expect(res.raw).toEqual({ role: "a-roll" });
		const content = (
			calls[0].body.messages as { content: { type: string }[] }[]
		)[0].content;
		expect(content[0]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,FRAME" },
		});
	});

	test("groq-llm (text-only): strips images, runs text-only, flags degraded", async () => {
		const { calls } = stubFetchJson(openAiReply('{"ok":1}'));
		const res = await planMultimodal({
			blocks,
			auth: { mode: "groq-llm", apiKey: "gsk" },
			schema: {},
		});
		expect(res.degraded).toBe(true);
		expect(res.raw).toEqual({ ok: 1 });
		// The frame bytes never left the process.
		expect(JSON.stringify(calls[0].body)).not.toContain("FRAME");
		expect(JSON.stringify(calls[0].body)).toContain("the director prompt");
	});

	test("xai-grok: image-capable, sends to the xAI endpoint", async () => {
		const { calls } = stubFetchJson(openAiReply("{}"));
		const res = await planMultimodal({
			blocks,
			auth: { mode: "xai-grok", apiKey: "xai-k" },
			schema: {},
		});
		expect(res.degraded).toBe(false);
		expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
	});
});

describe("chatTextCompletion - composition authoring transport", () => {
	test("api-key: Anthropic Messages, headroom max_tokens, no schema", async () => {
		const { calls } = stubFetchJson({
			content: [{ type: "text", text: "<!doctype html>" }],
			usage: { input_tokens: 9, output_tokens: 4 },
		});
		const res = await chatTextCompletion({
			prompt: "author this",
			auth: { mode: "api-key", apiKey: "sk-ant" },
		});
		expect(res.text).toBe("<!doctype html>");
		expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
		expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
		expect(calls[0].body.max_tokens).toBe(16000);
		expect(calls[0].body.output_config).toBeUndefined();
	});

	test("openai-family: chat/completions with the provider default model", async () => {
		const { calls } = stubFetchJson(openAiReply("<html></html>"));
		const res = await chatTextCompletion({
			prompt: "author this",
			auth: { mode: "groq-llm", apiKey: "gsk" },
		});
		expect(res.text).toBe("<html></html>");
		expect(calls[0].url).toBe(customChatUrl("https://api.groq.com/openai/v1"));
		expect(calls[0].body.model).toBe("llama-3.3-70b-versatile");
		expect(calls[0].body.response_format).toBeUndefined();
	});

	test("claude-code is rejected (that mode authors via the CLI skill)", async () => {
		await expect(
			chatTextCompletion({
				prompt: "x",
				auth: { mode: "claude-code" },
			}),
		).rejects.toThrow(/claude-code/);
	});
});
