import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { FREESOUND_NOT_CONFIGURED_ERROR } from "@/sounds/types";

// route.ts imports webEnv (@/env/web) directly and, transitively via
// checkRateLimit (@/auth/rate-limit), a second time - both are process-global
// singletons under bun's module cache, so both are mocked before the route is
// imported (mirrors the director route tests' mock-then-dynamic-import
// pattern). freesoundApiKey is mutable so each test can flip between a real
// key and the .env.example placeholder without re-mocking.
let freesoundApiKey = "a-real-test-key";

mock.module("@/env/web", () => ({
	webEnv: {
		get FREESOUND_API_KEY() {
			return freesoundApiKey;
		},
	},
}));

mock.module("@/auth/rate-limit", () => ({
	checkRateLimit: async () => ({ success: true, limited: false }),
}));

const { GET } = await import("../route");

function freesoundItem({ id }: { id: number }) {
	return {
		id,
		name: `sound-${id}`,
		description: "a test sound",
		url: `https://freesound.org/people/tester/sounds/${id}/`,
		previews: {
			"preview-hq-mp3": `https://freesound.org/data/previews/${id}-hq.mp3`,
			"preview-lq-mp3": `https://freesound.org/data/previews/${id}-lq.mp3`,
			"preview-hq-ogg": `https://freesound.org/data/previews/${id}-hq.ogg`,
			"preview-lq-ogg": `https://freesound.org/data/previews/${id}-lq.ogg`,
		},
		duration: 1.5,
		filesize: 1024,
		type: "wav",
		channels: 2,
		bitrate: 128,
		bitdepth: 16,
		samplerate: 44100,
		username: "tester",
		tags: ["sfx"],
		license: "Attribution",
		created: "2026-01-01T00:00:00Z",
		num_downloads: 3,
		avg_rating: 4,
		num_ratings: 2,
	};
}

function get(path: string): NextRequest {
	return new NextRequest(`http://localhost${path}`);
}

describe("/api/sounds/search", () => {
	test("BUG 2 fixed: commercial_only=false reaches Freesound as false, not mangled to true", async () => {
		freesoundApiKey = "a-real-test-key";
		let requestedUrl: string | null = null;
		const originalFetch = global.fetch;
		global.fetch = mock(async (url: string | URL) => {
			requestedUrl = url.toString();
			return new Response(
				JSON.stringify({
					count: 0,
					next: null,
					previous: null,
					results: [],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const res = await GET(get("/api/sounds/search?q=whoosh&commercial_only=false"));
			expect(res.status).toBe(200);
			expect(requestedUrl).not.toBeNull();
			const upstreamParams = new URL(requestedUrl as string).searchParams;
			// z.coerce.boolean() would have turned the STRING "false" into `true`
			// (Boolean("false") === true) - the exact no-op this fixes. With the
			// literal-string parse, the commercial-license filter clause must be
			// absent when commercial_only=false.
			const filters = upstreamParams.getAll("filter");
			expect(filters.some((f) => f.includes("license:"))).toBe(false);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("commercial_only=true (and the default) still applies the license filter", async () => {
		freesoundApiKey = "a-real-test-key";
		let requestedUrl: string | null = null;
		const originalFetch = global.fetch;
		global.fetch = mock(async (url: string | URL) => {
			requestedUrl = url.toString();
			return new Response(
				JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const res = await GET(get("/api/sounds/search?q=whoosh&commercial_only=true"));
			expect(res.status).toBe(200);
			const filters = new URL(requestedUrl as string).searchParams.getAll("filter");
			expect(filters.some((f) => f.includes("license:"))).toBe(true);

			// Omitting the param entirely (old callers, the pre-fix initial fetch)
			// must still default to the commercially-licensed-only behavior.
			const res2 = await GET(get("/api/sounds/search?q=whoosh"));
			expect(res2.status).toBe(200);
			const filters2 = new URL(requestedUrl as string).searchParams.getAll("filter");
			expect(filters2.some((f) => f.includes("license:"))).toBe(true);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("a configured key returns the transformed Freesound results", async () => {
		freesoundApiKey = "a-real-test-key";
		const originalFetch = global.fetch;
		global.fetch = mock(async () => {
			return new Response(
				JSON.stringify({
					count: 1,
					next: null,
					previous: null,
					results: [freesoundItem({ id: 42 })],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const res = await GET(get("/api/sounds/search?q=whoosh"));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.error).toBeUndefined();
			expect(body.count).toBe(1);
			expect(body.results).toHaveLength(1);
			expect(body.results[0].id).toBe(42);
			expect(body.results[0].previewUrl).toBe(
				"https://freesound.org/data/previews/42-hq.mp3",
			);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("friendly no-key state: missing FREESOUND_API_KEY never calls Freesound", async () => {
		freesoundApiKey = "";
		let fetchCalled = false;
		const originalFetch = global.fetch;
		global.fetch = mock(async () => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		try {
			const res = await GET(get("/api/sounds/search?q=whoosh"));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.error).toBe(FREESOUND_NOT_CONFIGURED_ERROR);
			expect(body.results).toEqual([]);
			expect(fetchCalled).toBe(false);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("friendly no-key state: the .env.example placeholder value is treated the same as missing", async () => {
		freesoundApiKey = "your_api_key_here";
		let fetchCalled = false;
		const originalFetch = global.fetch;
		global.fetch = mock(async () => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		try {
			const res = await GET(get("/api/sounds/search?q=whoosh"));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.error).toBe(FREESOUND_NOT_CONFIGURED_ERROR);
			expect(fetchCalled).toBe(false);
		} finally {
			global.fetch = originalFetch;
		}
	});
});
