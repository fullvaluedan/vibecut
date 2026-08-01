import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * T16.3 G6 reopen: a Groq cloud-transcription failure used to throw straight
 * out of `ensureTimelineTranscript` with no fallback and, depending on which
 * caller's abort signal happened to be attached to the shared run, sometimes
 * with nothing more informative than "Cancelled". These tests drive the real
 * orchestration in `transcript-cache.ts` - cloud fails, local is invoked
 * exactly once, the fallback is announced on the existing progress channel,
 * and a double failure reports BOTH reasons instead of hiding the first.
 *
 * Only the heavy IO the pipeline touches is stubbed (audio extraction/decode/
 * encode, the Whisper worker service, and `fetch`). `@/media/mediabunny` and
 * `@/media/audio` are widely imported elsewhere (core managers, the renderer,
 * waveform cache) for OTHER exports this file never touches, so mock.module
 * (process-global - it can leak into unrelated test files run in the same
 * `bun test` invocation) captures the real module first and only overrides
 * the one export each of these tests cares about, instead of replacing the
 * whole module and silently dropping every other export those other callers
 * need (caught the hard way: an earlier version of this file broke an
 * unrelated timeline-controller test with "Export named 'readVideoFile' not
 * found"). `@/media/audio-encode` and `@/services/transcription/service` have
 * exactly one export each already, so no passthrough is needed there.
 */

let extractTimelineAudioImpl = async () => new Blob(["audio"]);
let decodeAudioToFloat32Impl = async () => ({
	samples: new Float32Array(16),
	sampleRate: 16000,
});
let encodeAudioForUploadImpl: () => Promise<{
	blob: Blob;
	filename: string;
} | null> = async () => null;
let localTranscribeImpl: (args: {
	onProgress?: (p: { status: string; progress: number }) => void;
}) => Promise<{
	segments: { start: number; end: number; text: string }[];
	words?: { start: number; end: number; text: string }[];
	wordsUnavailable?: boolean;
}> = async () => ({
	segments: [{ start: 0, end: 1, text: "local ok" }],
});

let localTranscribeCalls = 0;

const realMediabunny = await import("@/media/mediabunny");
mock.module("@/media/mediabunny", () => ({
	...realMediabunny,
	extractTimelineAudio: () => extractTimelineAudioImpl(),
}));
const realAudio = await import("@/media/audio");
mock.module("@/media/audio", () => ({
	...realAudio,
	decodeAudioToFloat32: () => decodeAudioToFloat32Impl(),
}));
mock.module("@/media/audio-encode", () => ({
	encodeAudioForUpload: () => encodeAudioForUploadImpl(),
}));
mock.module("@/services/transcription/service", () => ({
	transcriptionService: {
		transcribe: async (args: {
			onProgress?: (p: { status: string; progress: number }) => void;
		}) => {
			localTranscribeCalls++;
			return localTranscribeImpl(args);
		},
	},
}));

const { useAiSettingsStore } = await import("@/features/ai-generate/store");
const {
	ensureTimelineTranscript,
	computeTimelineAudioHash,
} = await import("../transcript-cache");

const TPS = 120_000; // @/wasm's TICKS_PER_SECOND, mocked in test-preload.ts

interface FakeTracks {
	main: { elements: unknown[] };
	overlay: unknown[];
	audio: unknown[];
}

/** A minimal editor satisfying everything `run()` + the lineage reads touch. */
function makeFakeEditor({
	projectId,
	mediaId,
}: {
	projectId: string;
	mediaId: string;
}) {
	const tracks: FakeTracks = {
		main: {
			elements: [
				{
					type: "video",
					mediaId,
					startTime: 0,
					duration: 5 * TPS,
					trimStart: 0,
					trimEnd: 0,
				},
			],
		},
		overlay: [],
		audio: [],
	};
	return {
		project: { getActive: () => ({ metadata: { id: projectId } }) },
		scenes: { getActiveScene: () => ({ tracks }) },
		timeline: { getTotalDuration: () => 5 * TPS },
		media: { getAssets: () => [] },
	};
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
let testCounter = 0;

beforeEach(() => {
	fetchCalls = 0;
	localTranscribeCalls = 0;
	extractTimelineAudioImpl = async () => new Blob(["audio"]);
	decodeAudioToFloat32Impl = async () => ({
		samples: new Float32Array(16),
		sampleRate: 16000,
	});
	encodeAudioForUploadImpl = async () => null;
	localTranscribeImpl = async () => ({
		segments: [{ start: 0, end: 1, text: "local ok" }],
	});
	useAiSettingsStore.setState({
		transcriptionBackend: "cloud",
		groqApiKey: "test-key",
		directorVadGatedTranscriptionEnabled: false,
	});
	testCounter++;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	useAiSettingsStore.setState({
		transcriptionBackend: "in-browser",
		groqApiKey: "",
	});
});

function stubFetch(impl: typeof fetch) {
	globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
		fetchCalls++;
		return impl(...args);
	}) as typeof fetch;
}

describe("ensureTimelineTranscript - cloud failure falls back to local (T16.3 G6)", () => {
	test("a cloud 401 falls back to local exactly once and returns its result", async () => {
		stubFetch(async () =>
			Response.json(
				{ error: "Groq key rejected - check your key." },
				{ status: 401 },
			),
		);
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-a`,
			mediaId: "m1",
		});
		const result = await ensureTimelineTranscript({ editor: editor as never });
		expect(fetchCalls).toBe(1);
		expect(localTranscribeCalls).toBe(1);
		expect(result.segments).toEqual([{ start: 0, end: 1, text: "local ok" }]);
	});

	test("broadcasts the cloud failure reason before falling back", async () => {
		stubFetch(async () =>
			Response.json(
				{ error: "Groq key rejected - check your key." },
				{ status: 401 },
			),
		);
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-b`,
			mediaId: "m2",
		});
		const seen: string[] = [];
		await ensureTimelineTranscript({
			editor: editor as never,
			onProgress: (p) => seen.push(p.detail),
		});
		expect(
			seen.some(
				(detail) =>
					detail.includes("Groq key rejected - check your key.") &&
					detail.includes("using local transcription"),
			),
		).toBe(true);
	});

	test("a rate limit (429) also falls back, with the rate-limit reason broadcast", async () => {
		stubFetch(async () =>
			Response.json(
				{ error: "Groq rate limit hit - wait a moment and try again." },
				{ status: 429 },
			),
		);
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-c`,
			mediaId: "m3",
		});
		const seen: string[] = [];
		const result = await ensureTimelineTranscript({
			editor: editor as never,
			onProgress: (p) => seen.push(p.detail),
		});
		expect(localTranscribeCalls).toBe(1);
		expect(result.segments).toEqual([{ start: 0, end: 1, text: "local ok" }]);
		expect(seen.some((d) => d.includes("Groq rate limit hit"))).toBe(true);
	});

	test("a network failure (fetch throws) falls back too, with a connection message", async () => {
		stubFetch(async () => {
			throw new TypeError("Failed to fetch");
		});
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-d`,
			mediaId: "m4",
		});
		const seen: string[] = [];
		await ensureTimelineTranscript({
			editor: editor as never,
			onProgress: (p) => seen.push(p.detail),
		});
		expect(localTranscribeCalls).toBe(1);
		expect(
			seen.some((d) => d.includes("check your internet connection")),
		).toBe(true);
	});

	test("cloud success never invokes the local fallback", async () => {
		stubFetch(async () =>
			Response.json({
				text: "cloud ok",
				language: "english",
				segments: [{ start: 0, end: 1, text: "cloud ok" }],
			}),
		);
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-e`,
			mediaId: "m5",
		});
		const result = await ensureTimelineTranscript({ editor: editor as never });
		expect(localTranscribeCalls).toBe(0);
		expect(result.segments).toEqual([{ start: 0, end: 1, text: "cloud ok" }]);
	});

	test("cloud AND local both failing reports both reasons, not just the local one", async () => {
		stubFetch(async () =>
			Response.json({ error: "Groq key rejected - check your key." }, { status: 401 }),
		);
		localTranscribeImpl = async () => {
			throw new Error("model failed to load");
		};
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-f`,
			mediaId: "m6",
		});
		await expect(
			ensureTimelineTranscript({ editor: editor as never }),
		).rejects.toThrow(/Groq key rejected.*Local transcription also failed.*model failed to load/s);
		expect(localTranscribeCalls).toBe(1);
	});

	test("no retry loop: cloud is attempted exactly once even when it fails", async () => {
		stubFetch(async () => new Response("", { status: 500 }));
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-g`,
			mediaId: "m7",
		});
		await ensureTimelineTranscript({ editor: editor as never });
		expect(fetchCalls).toBe(1);
		expect(localTranscribeCalls).toBe(1);
	});

	test("in-browser backend (no cloud key) never calls fetch, goes straight to local", async () => {
		useAiSettingsStore.setState({
			transcriptionBackend: "in-browser",
			groqApiKey: "",
		});
		const editor = makeFakeEditor({
			projectId: `p-${testCounter}-h`,
			mediaId: "m8",
		});
		const result = await ensureTimelineTranscript({ editor: editor as never });
		expect(fetchCalls).toBe(0);
		expect(localTranscribeCalls).toBe(1);
		expect(result.segments).toEqual([{ start: 0, end: 1, text: "local ok" }]);
	});
});

describe("computeTimelineAudioHash sanity (fixture check)", () => {
	test("two different media ids produce different hashes", () => {
		const a = makeFakeEditor({ projectId: "x", mediaId: "one" });
		const b = makeFakeEditor({ projectId: "x", mediaId: "two" });
		expect(computeTimelineAudioHash(a as never)).not.toBe(
			computeTimelineAudioHash(b as never),
		);
	});
});
