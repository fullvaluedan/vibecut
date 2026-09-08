import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// The auth resolver is stubbed the same way the Director route tests stub it
// (bun's mock.module is process-global, so owning the registration keeps these
// tests deterministic whichever file ran before). The upstream call is stubbed
// by replacing global fetch: no live LLM call ever happens in the suite.
let authImpl: () => unknown = () => ({ mode: "api-key", apiKey: "test-key" });
let cliPlanImpl: (args: {
	prompt: string;
	auth: unknown;
	schema: object;
}) => Promise<{ raw: unknown; usage: null }> = ({ prompt }) =>
	Promise.resolve({ raw: { text: "cli says hi", toolCalls: [] }, usage: null });
let cliPlanCapture: { prompt: string; auth: unknown } | null = null;

mock.module("@/features/ai-generate/resolve-ai-auth", () => ({
	resolveAiAuth: () => authImpl(),
}));

// The CLI turn path is exercised through this app-internal seam so the
// shared hf-bridge module (used by the Director suites in the same Bun
// process) is never stubbed.
mock.module("@/features/assistant/cli-llm", () => ({
	cliPlanTurn: (args: {
		prompt: string;
		auth: unknown;
		schema: object;
	}) => {
		cliPlanCapture = { prompt: args.prompt, auth: args.auth };
		return cliPlanImpl(args);
	},
}));

const { POST } = await import("../route");

const realFetch = globalThis.fetch;

interface FetchCapture {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

let captured: FetchCapture | null = null;

function stubFetch(response: {
	ok?: boolean;
	status?: number;
	json?: unknown;
	text?: string;
}): void {
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		captured = {
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init?.body ?? "{}")),
		};
		return {
			ok: response.ok ?? true,
			status: response.status ?? 200,
			json: async () => response.json ?? {},
			text: async () => response.text ?? "",
		};
	}) as unknown as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	captured = null;
	authImpl = () => ({ mode: "api-key", apiKey: "test-key" });
	cliPlanImpl = ({ prompt }) =>
		Promise.resolve({ raw: { text: "cli says hi", toolCalls: [] }, usage: null });
	cliPlanCapture = null;
});

const context = {
	version: 1,
	project: {
		name: "Demo",
		fps: 30,
		aspect: "16:9",
		size: "1920x1080",
		durationSec: 16,
	},
	timeline: { mainTrackMagnet: true, rippleEditing: false, snapping: true },
	playheadSec: 7,
	selectedClipIds: [],
	tracks: [
		{
			label: "V1",
			type: "video",
			main: true,
			clipCount: 1,
			clips: [
				{
					id: "clip-intro",
					track: "V1",
					name: "intro.mp4",
					kind: "video",
					startSec: 0,
					endSec: 6,
				},
			],
		},
	],
	markers: [],
	truncated: false,
	notes: [],
};

function post(body?: unknown): NextRequest {
	return new NextRequest("http://localhost/api/assistant/edit", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("/api/assistant/edit", () => {
	test("401 when the AI connection is unconfigured, with no upstream call", async () => {
		authImpl = () => null;
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
		}) as unknown as typeof fetch;
		const res = await POST(post({ context, messages: [{ role: "user", content: "hi" }] }));
		expect(res.status).toBe(401);
		expect(called).toBe(false);
	});

	test("claude-code mode now WORKS via the schema-constrained CLI turn (was a 400 wall)", async () => {
		authImpl = () => ({ mode: "claude-code" });
		cliPlanImpl = () =>
			Promise.resolve({
				raw: {
					text: "Cutting the dead air.",
					toolCalls: [{ name: "cut_range", args: { startSec: 1, endSec: 2 } }],
				},
				usage: null,
			});
		const res = await POST(post({ context, messages: [{ role: "user", content: "tighten it" }] }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.text).toBe("Cutting the dead air.");
		expect(json.toolCalls).toHaveLength(1);
		expect(json.toolCalls[0].name).toBe("cut_range");
		expect(json.model).toBe("cli-assistant");
		expect(json.promptVersion).toBeDefined();
		// The CLI prompt carries the conversation and the auth mode rides along.
		expect(cliPlanCapture?.auth).toEqual({ mode: "claude-code" });
		expect(String(cliPlanCapture?.prompt)).toContain("tighten it");
	});

	test("codex mode (ChatGPT login) takes the same CLI turn path", async () => {
		authImpl = () => ({ mode: "codex", model: "gpt-5.1-codex" });
		cliPlanImpl = () =>
			Promise.resolve({ raw: { text: "Done.", toolCalls: [] }, usage: null });
		const res = await POST(post({ context, messages: [{ role: "user", content: "hello" }] }));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.text).toBe("Done.");
		expect(json.toolCalls).toEqual([]);
		expect(cliPlanCapture?.auth).toEqual({ mode: "codex", model: "gpt-5.1-codex" });
	});

	test("custom mode still declines with a plain-language 400", async () => {
		authImpl = () => ({
			mode: "custom",
			baseUrl: "http://localhost:11434/v1",
			model: "qwen",
		});
		const res = await POST(post({ context, messages: [{ role: "user", content: "hi" }] }));
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toContain("Settings");
	});

	test("400 on a missing or malformed context", async () => {
		expect((await POST(post({ messages: [{ role: "user", content: "hi" }] }))).status).toBe(400);
		expect(
			(await POST(post({ context: { tracks: "nope" }, messages: [{ role: "user", content: "hi" }] })))
				.status,
		).toBe(400);
	});

	test("400 on empty messages", async () => {
		expect((await POST(post({ context, messages: [] }))).status).toBe(400);
		expect((await POST(post({ context }))).status).toBe(400);
	});

	test("sends the system prompt, the tool schema and the history", async () => {
		stubFetch({
			json: {
				content: [{ type: "text", text: "Done." }],
				stop_reason: "end_turn",
				usage: { input_tokens: 11, output_tokens: 3 },
			},
		});
		const res = await POST(
			post({
				context,
				messages: [{ role: "user", content: "delete the intro" }],
			}),
		);
		expect(res.status).toBe(200);
		expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(captured?.headers["x-api-key"]).toBe("test-key");
		expect(captured?.body.model).toBe("claude-sonnet-5");
		expect(String(captured?.body.system)).toContain("edit operator for VibeCut");
		expect(String(captured?.body.system)).toContain("clip-intro");
		const tools = captured?.body.tools as { name: string }[];
		expect(tools.map((tool) => tool.name)).toContain("ask_user");
		expect(tools.map((tool) => tool.name)).toContain("extend_clip");
		expect(captured?.body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "delete the intro" }] },
		]);
	});

	test("returns tool calls and the plain-language summary", async () => {
		stubFetch({
			json: {
				content: [
					{ type: "text", text: "Removing the intro clip." },
					{
						type: "tool_use",
						id: "toolu_1",
						name: "delete_clip",
						input: { clipId: "clip-intro" },
					},
				],
				stop_reason: "tool_use",
				usage: { input_tokens: 20, output_tokens: 9 },
			},
		});
		const res = await POST(
			post({ context, messages: [{ role: "user", content: "drop the intro" }] }),
		);
		const json = await res.json();
		expect(json.text).toBe("Removing the intro clip.");
		expect(json.toolCalls).toEqual([
			{ id: "toolu_1", name: "delete_clip", args: { clipId: "clip-intro" } },
		]);
		expect(json.question).toBeNull();
		expect(json.usage).toEqual({ inputTokens: 20, outputTokens: 9 });
		expect(json.promptVersion).toBe(1);
		expect(json.model).toBe("claude-sonnet-5");
		expect(json.stopReason).toBe("tool_use");
	});

	test("surfaces an ask_user clarifying question", async () => {
		stubFetch({
			json: {
				content: [
					{
						type: "tool_use",
						id: "toolu_2",
						name: "ask_user",
						input: {
							question: "Do you mean the intro at 0s or the body clip at 6s?",
							options: ["intro", "body"],
						},
					},
				],
				stop_reason: "tool_use",
			},
		});
		const json = await (
			await POST(post({ context, messages: [{ role: "user", content: "cut the boring bit" }] }))
		).json();
		expect(json.question).toBe("Do you mean the intro at 0s or the body clip at 6s?");
		expect(json.questionOptions).toEqual(["intro", "body"]);
		expect(json.toolCalls).toHaveLength(1);
	});

	test("replays prior tool calls and results as provider blocks", async () => {
		stubFetch({ json: { content: [{ type: "text", text: "ok" }] } });
		await POST(
			post({
				context,
				messages: [
					{ role: "user", content: "delete the intro" },
					{
						role: "assistant",
						content: "Removing it.",
						toolCalls: [
							{ id: "toolu_1", name: "delete_clip", args: { clipId: "clip-intro" } },
						],
					},
				],
				toolResults: [
					{ toolCallId: "toolu_1", ok: true, summary: "Deleted intro.mp4." },
				],
			}),
		);
		expect(captured?.body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "delete the intro" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Removing it." },
					{
						type: "tool_use",
						id: "toolu_1",
						name: "delete_clip",
						input: { clipId: "clip-intro" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: "Deleted intro.mp4.",
					},
				],
			},
		]);
	});

	test("a failed tool result is marked as an error for the model", async () => {
		stubFetch({ json: { content: [{ type: "text", text: "ok" }] } });
		await POST(
			post({
				context,
				messages: [{ role: "user", content: "extend it" }],
				toolResults: [
					{ toolCallId: "toolu_9", ok: false, summary: "No more footage." },
				],
			}),
		);
		const messages = captured?.body.messages as { content: unknown[] }[];
		expect(messages[messages.length - 1].content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu_9",
				content: "No more footage.",
				is_error: true,
			},
		]);
	});

	test("honours a model override", async () => {
		stubFetch({ json: { content: [] } });
		await POST(
			post({
				context,
				messages: [{ role: "user", content: "hi" }],
				model: "claude-opus-4-8",
			}),
		);
		expect(captured?.body.model).toBe("claude-opus-4-8");
	});

	test("502 when the provider rejects the call", async () => {
		stubFetch({ ok: false, status: 500, text: "upstream boom" });
		const res = await POST(post({ context, messages: [{ role: "user", content: "hi" }] }));
		expect(res.status).toBe(502);
		expect((await res.json()).error).toContain("upstream boom");
	});

	test("401 is passed through as 401 so the UI can point at Settings", async () => {
		stubFetch({ ok: false, status: 401, text: "invalid key" });
		expect(
			(await POST(post({ context, messages: [{ role: "user", content: "hi" }] }))).status,
		).toBe(401);
	});

	test("500 when the upstream call throws", async () => {
		globalThis.fetch = (async () => {
			throw new Error("socket hang up");
		}) as unknown as typeof fetch;
		const res = await POST(post({ context, messages: [{ role: "user", content: "hi" }] }));
		expect(res.status).toBe(500);
		expect((await res.json()).error).toContain("socket hang up");
	});
});
