import { afterEach, describe, expect, mock, test } from "bun:test";

// The claude-code degrade path spawns the `claude` CLI; stub node:child_process
// so the test never launches a process. Registered before importing the module
// under test (mirrors the @/wasm-stub pattern in the timeline tests).
type FakeChild = {
	stdout: { on: (ev: string, cb: (d: Buffer) => void) => void };
	stderr: { on: (ev: string, cb: (d: Buffer) => void) => void };
	stdin: { write: (s: string) => void; end: () => void };
	on: (ev: string, cb: (code: number) => void) => void;
};
let fakeSpawn: () => FakeChild = () => {
	throw new Error("fakeSpawn not configured for this test");
};
mock.module("node:child_process", () => ({ spawn: () => fakeSpawn() }));

const {
	planMultimodal,
	partitionMultimodalBlocks,
	buildAnthropicMultimodalBody,
	buildCustomMultimodalBody,
	assertSafeMultimodalHost,
	MAX_MULTIMODAL_IMAGES,
} = await import("../author");

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function jsonResponse(obj: unknown, status = 200): Response {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("planMultimodal — api-key (Anthropic Messages)", () => {
	test("sends images before text, returns schema JSON + usage, not degraded", async () => {
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string, opts: { body: string }) => {
			capturedBody = JSON.parse(opts.body);
			return jsonResponse({
				content: [{ type: "text", text: '{"role":"b-roll"}' }],
				usage: { input_tokens: 12, output_tokens: 4 },
			});
		}) as unknown as typeof fetch;

		const res = await planMultimodal({
			blocks: [
				{ type: "image", mediaType: "image/jpeg", dataBase64: "AAAA" },
				{ type: "text", text: "classify this asset" },
			],
			auth: { mode: "api-key", apiKey: "sk-test" },
			schema: { type: "object" },
		});

		expect(res).toEqual({
			raw: { role: "b-roll" },
			usage: { inputTokens: 12, outputTokens: 4 },
			degraded: false,
		});
		const content = (
			capturedBody.messages as { content: { type: string }[] }[]
		)[0].content;
		expect(content[0].type).toBe("image");
		expect(content[content.length - 1].type).toBe("text");
		// Bulk default model.
		expect(capturedBody.model).toBe("claude-sonnet-4-6");
	});

	test("honors a hard-call model override (claude-opus-4-8)", async () => {
		let body: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string, opts: { body: string }) => {
			body = JSON.parse(opts.body);
			return jsonResponse({ content: [{ type: "text", text: "{}" }] });
		}) as unknown as typeof fetch;

		await planMultimodal({
			blocks: [{ type: "text", text: "x" }],
			auth: { mode: "api-key", apiKey: "k" },
			schema: {},
			model: "claude-opus-4-8",
		});
		expect(body.model).toBe("claude-opus-4-8");
	});

	test("a transport failure surfaces a typed error", async () => {
		globalThis.fetch = (async () =>
			new Response("upstream boom", { status: 500 })) as unknown as typeof fetch;
		await expect(
			planMultimodal({
				blocks: [{ type: "text", text: "x" }],
				auth: { mode: "api-key", apiKey: "k" },
				schema: {},
			}),
		).rejects.toThrow(/Anthropic API error 500/);
	});

	test("malformed (non-JSON) output surfaces a clear error, not a raw crash", async () => {
		globalThis.fetch = (async () =>
			jsonResponse({
				content: [{ type: "text", text: "this is not json at all" }],
			})) as unknown as typeof fetch;
		await expect(
			planMultimodal({
				blocks: [{ type: "text", text: "x" }],
				auth: { mode: "api-key", apiKey: "k" },
				schema: {},
			}),
		).rejects.toThrow(/no parseable JSON/);
	});
});

describe("planMultimodal — claude-code degrade", () => {
	test("strips images, dispatches text-only, flags degraded", async () => {
		let capturedStdin = "";
		fakeSpawn = () => ({
			stdout: {
				on: (ev: string, cb: (d: Buffer) => void) => {
					if (ev === "data") {
						queueMicrotask(() =>
							cb(
								Buffer.from(
									JSON.stringify({
										result: '{"ok":1}',
										usage: { input_tokens: 3, output_tokens: 1 },
									}),
								),
							),
						);
					}
				},
			},
			stderr: { on: () => {} },
			stdin: {
				write: (s: string) => {
					capturedStdin += s;
				},
				end: () => {},
			},
			on: (ev: string, cb: (code: number) => void) => {
				if (ev === "close") queueMicrotask(() => cb(0));
			},
		});

		const res = await planMultimodal({
			blocks: [
				{ type: "image", mediaType: "image/jpeg", dataBase64: "SECRETFRAMEBYTES" },
				{ type: "text", text: "the director prompt" },
			],
			auth: { mode: "claude-code" },
			schema: {},
		});

		expect(res.degraded).toBe(true);
		expect(res.raw).toEqual({ ok: 1 });
		expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
		// Only the text reached the CLI — the frame bytes were stripped.
		expect(capturedStdin).toBe("the director prompt");
		expect(capturedStdin).not.toContain("SECRETFRAMEBYTES");
	});
});

describe("planMultimodal — custom endpoint SSRF guard", () => {
	test("assertSafeMultimodalHost rejects loopback / IP / non-https / internal", () => {
		expect(() => assertSafeMultimodalHost("http://169.254.169.254")).toThrow();
		expect(() => assertSafeMultimodalHost("https://127.0.0.1")).toThrow();
		expect(() => assertSafeMultimodalHost("http://api.example.com")).toThrow();
		expect(() => assertSafeMultimodalHost("https://localhost")).toThrow();
		expect(() => assertSafeMultimodalHost("https://vision.internal")).toThrow();
		expect(() => assertSafeMultimodalHost("https://api.example.com/v1")).not.toThrow();
	});

	test("rejects a private/loopback baseUrl BEFORE any frame is sent", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return jsonResponse({});
		}) as unknown as typeof fetch;

		await expect(
			planMultimodal({
				blocks: [{ type: "image", mediaType: "image/jpeg", dataBase64: "X" }],
				auth: { mode: "custom", baseUrl: "http://169.254.169.254", model: "llava" },
				schema: {},
			}),
		).rejects.toThrow(/not allowed/);
		expect(fetchCalled).toBe(false);
	});
});

describe("multimodal body builders + image cap", () => {
	test("partitionMultimodalBlocks truncates over the cap and warns (no silent drop)", () => {
		const realWarn = console.warn;
		let warned = "";
		console.warn = (msg: string) => {
			warned = msg;
		};
		try {
			const blocks = [
				...Array.from({ length: MAX_MULTIMODAL_IMAGES + 5 }, (_, i) => ({
					type: "image" as const,
					mediaType: "image/jpeg",
					dataBase64: `frame-${i}`,
				})),
				{ type: "text" as const, text: "signals" },
			];
			const { images, text, truncated } = partitionMultimodalBlocks(blocks);
			expect(images).toHaveLength(MAX_MULTIMODAL_IMAGES);
			expect(truncated).toBe(true);
			expect(text).toBe("signals");
			expect(warned).toContain("exceeds cap");
		} finally {
			console.warn = realWarn;
		}
	});

	test("buildAnthropicMultimodalBody: images-before-text + base64 source + json_schema", () => {
		const body = buildAnthropicMultimodalBody({
			images: [{ mediaType: "image/png", dataBase64: "AAA" }],
			text: "hi",
			schema: { type: "object" },
		}) as {
			messages: { content: { type: string }[] }[];
			output_config: { format: { type: string } };
		};
		const content = body.messages[0].content;
		expect(content[0]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "AAA" },
		});
		expect(content[1]).toEqual({ type: "text", text: "hi" });
		expect(body.output_config.format.type).toBe("json_schema");
	});

	test("buildCustomMultimodalBody: image_url data URIs before text", () => {
		const body = buildCustomMultimodalBody({
			images: [{ mediaType: "image/jpeg", dataBase64: "BBB" }],
			text: "yo",
			model: "llava",
		}) as { messages: { content: { type: string }[] }[] };
		const content = body.messages[0].content;
		expect(content[0]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,BBB" },
		});
		expect(content[1].type).toBe("text");
	});
});
