import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/**
 * Round 21 groundwork: a deployment can set a server-side GROQ_API_KEY so
 * cloud transcription works without every user pasting their own key into
 * Settings -> AI. These tests drive the real route handlers AND the real
 * `transcribeWithGroq` (no mock.module on that path - it is process-global for
 * the whole `bun test` invocation and would leak into
 * `providers/__tests__/groq.test.ts`, which imports the same module
 * unmocked). Only the network boundary (`fetch`) is stubbed, same technique
 * `groq.test.ts` already uses.
 */

const { GET, POST } = await import("../route");

const originalFetch = globalThis.fetch;
const ORIGINAL_GROQ_ENV_KEY = process.env.GROQ_API_KEY;

let lastAuthHeader: string | null = null;
let groqResponseImpl: () => Promise<Response> = async () =>
	Response.json({ text: "hi", segments: [], language: "en" });

function stubGroqFetch() {
	globalThis.fetch = (async (
		_url: RequestInfo | URL,
		init?: RequestInit,
	) => {
		lastAuthHeader = init?.headers
			? new Headers(init.headers).get("Authorization")
			: null;
		return groqResponseImpl();
	}) as typeof fetch;
}

function postRequest({
	headerKey,
	withAudio = true,
}: {
	headerKey?: string;
	withAudio?: boolean;
}): NextRequest {
	const headers: Record<string, string> = {
		"x-framecut-transcribe-provider": "groq",
	};
	if (headerKey) headers["x-framecut-transcribe-key"] = headerKey;
	const form = new FormData();
	if (withAudio) form.append("audio", new Blob(["fake audio"]), "clip.wav");
	return new NextRequest("http://localhost/api/transcribe", {
		method: "POST",
		headers,
		body: form,
	});
}

beforeEach(() => {
	lastAuthHeader = null;
	groqResponseImpl = async () =>
		Response.json({ text: "hi", segments: [], language: "en" });
	stubGroqFetch();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (ORIGINAL_GROQ_ENV_KEY === undefined) {
		delete process.env.GROQ_API_KEY;
	} else {
		process.env.GROQ_API_KEY = ORIGINAL_GROQ_ENV_KEY;
	}
});

describe("POST /api/transcribe - Groq key precedence", () => {
	test("the device-local header key wins over a server GROQ_API_KEY", async () => {
		process.env.GROQ_API_KEY = "env-secret-key";
		const res = await POST(postRequest({ headerKey: "header-secret-key" }));
		expect(res.status).toBe(200);
		expect(lastAuthHeader).toBe("Bearer header-secret-key");
	});

	test("falls back to the server GROQ_API_KEY when no header key is sent", async () => {
		process.env.GROQ_API_KEY = "env-secret-key";
		const res = await POST(postRequest({}));
		expect(res.status).toBe(200);
		expect(lastAuthHeader).toBe("Bearer env-secret-key");
	});

	test("401 with a clear, actionable message when neither key exists", async () => {
		delete process.env.GROQ_API_KEY;
		const res = await POST(postRequest({}));
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toBe(
			"No Groq key configured - add one in Settings or set GROQ_API_KEY.",
		);
		expect(lastAuthHeader).toBeNull(); // Groq was never called
	});

	test("the server key is never echoed in a successful response body", async () => {
		process.env.GROQ_API_KEY = "super-secret-env-key-xyz";
		const res = await POST(postRequest({}));
		const text = await res.text();
		expect(text).not.toContain("super-secret-env-key-xyz");
	});

	test("the server key is never echoed when the upstream Groq call fails", async () => {
		process.env.GROQ_API_KEY = "super-secret-env-key-abc";
		groqResponseImpl = async () => new Response("invalid_api_key", { status: 401 });
		const res = await POST(postRequest({}));
		expect(res.status).toBe(401);
		const text = await res.text();
		expect(text).toContain("Groq key rejected - check your key.");
		expect(text).not.toContain("super-secret-env-key-abc");
	});
});

describe("GET /api/transcribe - server-key availability probe", () => {
	test("reports groqServerKey: true when GROQ_API_KEY is set", async () => {
		process.env.GROQ_API_KEY = "some-server-key";
		const res = await GET();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ groqServerKey: true });
	});

	test("reports groqServerKey: false when GROQ_API_KEY is unset", async () => {
		delete process.env.GROQ_API_KEY;
		const res = await GET();
		expect(await res.json()).toEqual({ groqServerKey: false });
	});

	test("reports groqServerKey: false for an empty-string env value", async () => {
		process.env.GROQ_API_KEY = "";
		const res = await GET();
		expect(await res.json()).toEqual({ groqServerKey: false });
	});

	test("never reveals the key value itself", async () => {
		process.env.GROQ_API_KEY = "super-secret-env-key-probe";
		const res = await GET();
		const text = await res.text();
		expect(text).not.toContain("super-secret-env-key-probe");
	});
});
