import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	probeServerGroqKey,
	resetServerGroqKeyProbeForTests,
	shouldAttemptCloudTranscription,
	useAiSettingsStore,
} from "../store";

/**
 * Round 21 groundwork: `shouldAttemptCloudTranscription` is the single gate
 * both cloud-transcription call sites (transcript-cache.ts and
 * director/asset-transcribe.ts) share. It decides whether to attempt Groq
 * cloud transcription: backend must be "cloud", AND either a device-local
 * key is set or GET /api/transcribe reports a server-configured one. The
 * probe is fetched once and cached module-level (`probeServerGroqKey`);
 * `resetServerGroqKeyProbeForTests` clears that cache between scenarios.
 */

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

function stubProbeFetch(groqServerKey: boolean) {
	globalThis.fetch = (async () => {
		fetchCalls++;
		return Response.json({ groqServerKey });
	}) as typeof fetch;
}

beforeEach(() => {
	fetchCalls = 0;
	resetServerGroqKeyProbeForTests();
	useAiSettingsStore.setState({ transcriptionBackend: "in-browser", groqApiKey: "" });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetServerGroqKeyProbeForTests();
	useAiSettingsStore.setState({ transcriptionBackend: "in-browser", groqApiKey: "" });
});

describe("shouldAttemptCloudTranscription", () => {
	test("backend not cloud: false, never probes", async () => {
		useAiSettingsStore.setState({ transcriptionBackend: "in-browser", groqApiKey: "" });
		stubProbeFetch(true);
		expect(await shouldAttemptCloudTranscription()).toBe(false);
		expect(fetchCalls).toBe(0);
	});

	test("cloud backend + device-local key: true, never probes", async () => {
		useAiSettingsStore.setState({ transcriptionBackend: "cloud", groqApiKey: "gsk_local" });
		stubProbeFetch(false); // would fail if consulted
		expect(await shouldAttemptCloudTranscription()).toBe(true);
		expect(fetchCalls).toBe(0);
	});

	test("cloud backend, no local key, server reports a key: true, probes once", async () => {
		useAiSettingsStore.setState({ transcriptionBackend: "cloud", groqApiKey: "" });
		stubProbeFetch(true);
		expect(await shouldAttemptCloudTranscription()).toBe(true);
		expect(fetchCalls).toBe(1);
	});

	test("cloud backend, no local key, server reports none: false (existing no-key behavior preserved)", async () => {
		useAiSettingsStore.setState({ transcriptionBackend: "cloud", groqApiKey: "" });
		stubProbeFetch(false);
		expect(await shouldAttemptCloudTranscription()).toBe(false);
		expect(fetchCalls).toBe(1);
	});

	test("a probe network failure is treated as no server key, not a throw", async () => {
		useAiSettingsStore.setState({ transcriptionBackend: "cloud", groqApiKey: "" });
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new TypeError("Failed to fetch");
		}) as typeof fetch;
		await expect(shouldAttemptCloudTranscription()).resolves.toBe(false);
	});
});

describe("probeServerGroqKey caching", () => {
	test("caches the result: a second call does not re-fetch", async () => {
		stubProbeFetch(true);
		expect(await probeServerGroqKey()).toBe(true);
		expect(await probeServerGroqKey()).toBe(true);
		expect(fetchCalls).toBe(1);
	});

	test("resetServerGroqKeyProbeForTests forces a fresh probe", async () => {
		stubProbeFetch(true);
		expect(await probeServerGroqKey()).toBe(true);
		expect(fetchCalls).toBe(1);
		resetServerGroqKeyProbeForTests();
		fetchCalls = 0;
		stubProbeFetch(false);
		expect(await probeServerGroqKey()).toBe(false);
		expect(fetchCalls).toBe(1);
	});
});
