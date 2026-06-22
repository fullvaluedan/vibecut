/**
 * One transcript, used everywhere. The timeline's audio content is hashed
 * (asset ids + placement + trims); the transcript for that exact state is
 * cached on this device and shared by AI CUT, RUN HYPERFRAMES, and the
 * background transcriber that kicks in whenever the timeline changes.
 */

import { create } from "zustand";
import type { EditorCore } from "@/core";
import { decodeAudioToFloat32 } from "@/media/audio";
import { extractTimelineAudio } from "@/media/mediabunny";
import { transcriptionService } from "@/services/transcription/service";
import {
	buildTranscribeHeaders,
	useAiSettingsStore,
} from "@/features/ai-generate/store";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { selectAnalysisModel } from "@/transcription/analysis-model";
import { TICKS_PER_SECOND } from "@/wasm";

export interface TranscriptSegmentLite {
	start: number;
	end: number;
	text: string;
}

export interface TranscriptWordLite {
	start: number;
	end: number;
	text: string;
}

export interface TranscribeProgress {
	phase: "extracting" | "downloading-model" | "initializing-model" | "transcribing";
	detail: string;
	/** 0..1 where known (model download). */
	progress?: number;
}

interface CacheEntry {
	hash: string;
	segments: TranscriptSegmentLite[];
	/** Present only when this entry was produced with word timestamps. */
	words?: TranscriptWordLite[];
	/**
	 * Set when words were requested but this device's model couldn't produce
	 * them. Lets a `wantWords` request count as a cache hit (so we don't
	 * re-transcribe every run) even though no words are stored.
	 */
	wordsUnavailable?: boolean;
	createdAt: number;
}

const CACHE_KEY = "vibecut-transcript-cache";
const MAX_PROJECT_ENTRIES = 6;

interface TranscriptStatusStore {
	status: "idle" | "transcribing" | "ready" | "error";
	setStatus: (status: TranscriptStatusStore["status"]) => void;
}

/** Tiny status surface for UI chips ("Transcribing in background…"). */
export const useTranscriptStatusStore = create<TranscriptStatusStore>(
	(set) => ({
		status: "idle",
		setStatus: (status) => set({ status }),
	}),
);

/**
 * Hash of everything that affects the timeline's WORDS: which media plays
 * when, with what trims. Volume/effects/text don't change the transcript.
 */
export function computeTimelineAudioHash(editor: EditorCore): string {
	const tracks = editor.scenes.getActiveScene().tracks;
	const parts: string[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const el of track.elements) {
			const obj = el as {
				type: string;
				mediaId?: string;
				startTime: number;
				duration: number;
				trimStart?: number;
				trimEnd?: number;
				isSourceAudioEnabled?: boolean;
			};
			if (obj.type !== "video" && obj.type !== "audio") continue;
			if (obj.type === "video" && obj.isSourceAudioEnabled === false) continue;
			parts.push(
				[
					obj.mediaId ?? "",
					Math.round(obj.startTime),
					Math.round(obj.duration),
					Math.round(obj.trimStart ?? 0),
					Math.round(obj.trimEnd ?? 0),
				].join(":"),
			);
		}
	}
	parts.sort();
	// djb2 over the joined string — collision-safe enough for a local cache.
	let hash = 5381;
	const joined = parts.join("|");
	for (let i = 0; i < joined.length; i++) {
		hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
	}
	return `${parts.length}-${(hash >>> 0).toString(36)}`;
}

function readCache(): Record<string, CacheEntry> {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return {};
		return JSON.parse(raw) as Record<string, CacheEntry>;
	} catch {
		return {};
	}
}

function writeCache(projectId: string, entry: CacheEntry): void {
	try {
		const cache = readCache();
		cache[projectId] = entry;
		const keys = Object.keys(cache);
		if (keys.length > MAX_PROJECT_ENTRIES) {
			keys
				.sort((a, b) => cache[a].createdAt - cache[b].createdAt)
				.slice(0, keys.length - MAX_PROJECT_ENTRIES)
				.forEach((key) => delete cache[key]);
		}
		localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
	} catch {
		// Cache is an optimization — quota errors must never break a run.
	}
}

/** The hash-matched cache entry for the current timeline, or null on a miss. */
function getCachedEntry(editor: EditorCore): CacheEntry | null {
	const projectId = editor.project.getActive().metadata.id;
	const entry = readCache()[projectId];
	if (!entry) return null;
	return entry.hash === computeTimelineAudioHash(editor) ? entry : null;
}

export function getCachedTranscript(
	editor: EditorCore,
): TranscriptSegmentLite[] | null {
	return getCachedEntry(editor)?.segments ?? null;
}

let inFlight: Promise<{
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
	wordsUnavailable?: boolean;
}> | null = null;
let inFlightHash: string | null = null;
let inFlightHasWords = false;

// Every caller that joins the same in-flight transcription subscribes here, so
// progress reaches ALL of them — not just whoever started the run. Without this,
// clicking RUN HYPERFRAMES while the background transcriber's NO-progress run
// was already in flight made the button JOIN that promise and receive zero
// callbacks, freezing the bar at "Reading audio 5%" for the whole run.
const progressSubscribers = new Set<(p: TranscribeProgress) => void>();
let lastProgress: TranscribeProgress | null = null;
function broadcastProgress(p: TranscribeProgress): void {
	lastProgress = p;
	for (const sub of progressSubscribers) {
		try {
			sub(p);
		} catch {
			// a throwing subscriber must not break transcription
		}
	}
}

/**
 * The single transcription pipeline. Cache hit → instant. Otherwise extract
 * → decode → transcribe with honest staged progress (including a live
 * elapsed-seconds ticker while the model initializes — the stage that used
 * to look frozen at "20%"). Concurrent callers for the same timeline state
 * share one run.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Parse the /api/transcribe response (a normalized TranscriptionResult) into the
 * cache's lite shape, dropping malformed entries. The route already normalized
 * it; this re-validates at the boundary and keeps only the fields we cache.
 */
function parseCloudTranscript(payload: unknown): {
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
} {
	const segments: TranscriptSegmentLite[] = [];
	const words: TranscriptWordLite[] = [];
	if (isRecord(payload)) {
		const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
		for (const entry of rawSegments) {
			if (
				isRecord(entry) &&
				typeof entry.start === "number" &&
				typeof entry.end === "number" &&
				typeof entry.text === "string"
			) {
				segments.push({ start: entry.start, end: entry.end, text: entry.text });
			}
		}
		const rawWords = Array.isArray(payload.words) ? payload.words : [];
		for (const entry of rawWords) {
			if (
				isRecord(entry) &&
				typeof entry.start === "number" &&
				typeof entry.end === "number" &&
				typeof entry.text === "string"
			) {
				words.push({ start: entry.start, end: entry.end, text: entry.text });
			}
		}
	}
	return { segments, words: words.length > 0 ? words : undefined };
}

export async function ensureTimelineTranscript({
	editor,
	onProgress,
	signal,
	wantWords = false,
}: {
	editor: EditorCore;
	onProgress?: (p: TranscribeProgress) => void;
	signal?: AbortSignal;
	/** Also produce per-word timing (for the Director's duplicate detector). */
	wantWords?: boolean;
}): Promise<{
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
	/** True when words were requested but the model couldn't produce them. */
	wordsUnavailable?: boolean;
	fromCache: boolean;
}> {
	const cachedEntry = getCachedEntry(editor);
	// A hash match is a hit even when the transcript is EMPTY (a silent /
	// music-only timeline) — `[]` is a valid cached result. A word-level request
	// counts as a hit when the entry carries words OR was flagged as words-
	// unavailable (the model can't produce them — re-running would only fail the
	// same way and waste a full transcription).
	if (
		cachedEntry &&
		(!wantWords || cachedEntry.words || cachedEntry.wordsUnavailable)
	) {
		return {
			segments: cachedEntry.segments,
			words: cachedEntry.words,
			wordsUnavailable: cachedEntry.wordsUnavailable,
			fromCache: true,
		};
	}

	const hash = computeTimelineAudioHash(editor);
	const projectId = editor.project.getActive().metadata.id;

	const abortable = <T>(promise: Promise<T>): Promise<T> => {
		if (!signal) return promise;
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				const onAbort = () => reject(new Error("Cancelled"));
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	};

	// Subscribe to live progress whether we START the run or JOIN one already in
	// flight, and replay the latest stage immediately so a joiner's bar jumps to
	// the real current stage instead of freezing at whatever it last set.
	if (onProgress) {
		progressSubscribers.add(onProgress);
		if (lastProgress) onProgress(lastProgress);
	}

	if (inFlight && inFlightHash === hash && (!wantWords || inFlightHasWords)) {
		try {
			const result = await abortable(inFlight);
			return { ...result, fromCache: false };
		} finally {
			if (onProgress) progressSubscribers.delete(onProgress);
		}
	}

	const run = async (): Promise<{
		segments: TranscriptSegmentLite[];
		words?: TranscriptWordLite[];
		wordsUnavailable?: boolean;
	}> => {
		const totalDuration = editor.timeline.getTotalDuration();
		if (totalDuration / TICKS_PER_SECOND < 1) {
			throw new Error("Add some footage to the timeline first.");
		}
		// Analysis path only: trade accuracy for speed on long sources (a 16-min
		// recording on whisper-small takes minutes). Captions pick their own model.
		const analysisModel = selectAnalysisModel({
			durationSec: totalDuration / TICKS_PER_SECOND,
		});
		broadcastProgress({
			phase: "extracting",
			detail: "Extracting timeline audio...",
		});
		const audioBlob = await extractTimelineAudio({
			tracks: editor.scenes.getActiveScene().tracks,
			mediaAssets: editor.media.getAssets(),
			totalDuration,
		});

		// Cloud backend (opt-in, BYO key): upload the WAV to /api/transcribe
		// instead of decoding + running Whisper in the browser. Fast, accurate,
		// and always word-level (re-arms the Director's word detectors), so
		// `wantWords` is always satisfied and `wordsUnavailable` never trips.
		const aiSettings = useAiSettingsStore.getState();
		if (aiSettings.transcriptionBackend === "cloud" && aiSettings.groqApiKey) {
			const startedAt = Date.now();
			broadcastProgress({
				phase: "transcribing",
				detail: "Uploading audio to the cloud transcriber...",
			});
			const cloudTicker = setInterval(() => {
				const sec = Math.round((Date.now() - startedAt) / 1000);
				broadcastProgress({
					phase: "transcribing",
					detail: `Transcribing in the cloud — ${sec}s elapsed...`,
				});
			}, 1000);
			try {
				const form = new FormData();
				form.append("audio", audioBlob, "timeline.wav");
				const response = await abortable(
					fetch("/api/transcribe", {
						method: "POST",
						headers: buildTranscribeHeaders(),
						body: form,
						signal,
					}),
				);
				if (!response.ok) {
					const detail: unknown = await response.json().catch(() => null);
					const message =
						isRecord(detail) && typeof detail.error === "string"
							? detail.error
							: `Cloud transcription failed (${response.status}).`;
					throw new Error(message);
				}
				const { segments, words } = parseCloudTranscript(await response.json());
				writeCache(projectId, {
					hash,
					segments,
					words,
					wordsUnavailable: undefined,
					createdAt: Date.now(),
				});
				return { segments, words, wordsUnavailable: undefined };
			} finally {
				clearInterval(cloudTicker);
			}
		}

		const { samples } = await decodeAudioToFloat32({
			audioBlob,
			sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
		});

		// Live elapsed ticker so neither model init NOR a long transcription LOOKS
		// frozen. One interval at a time; it's restarted when the phase changes.
		let ticker: ReturnType<typeof setInterval> | null = null;
		let transcribeStarted = false;
		const stopTicker = () => {
			if (ticker) {
				clearInterval(ticker);
				ticker = null;
			}
		};
		try {
			const transcript = await transcriptionService.transcribe({
				audioData: samples,
				modelId: analysisModel,
				wordTimestamps: wantWords,
				onProgress: (p) => {
					if (p.status === "loading-model") {
						if (p.progress >= 100) {
							if (!ticker) {
								const initStartedAt = Date.now();
								ticker = setInterval(() => {
									const sec = Math.round((Date.now() - initStartedAt) / 1000);
									broadcastProgress({
										phase: "initializing-model",
										detail: `Initializing speech model — ${sec}s elapsed (first run can take about a minute; later runs are instant)...`,
										progress: 1,
									});
								}, 1000);
								broadcastProgress({
									phase: "initializing-model",
									detail:
										"Speech model downloaded — initializing (first run can take about a minute)...",
									progress: 1,
								});
							}
						} else {
							broadcastProgress({
								phase: "downloading-model",
								detail: `Downloading speech model (one-time, ~40 MB): ${Math.round(p.progress)}%`,
								progress: p.progress / 100,
							});
						}
					} else if (p.status === "transcribing" && !transcribeStarted) {
						// Real decoding started — stop the init ticker and run a fresh
						// elapsed ticker for THIS phase. Honest copy: on a long video the
						// transcription itself takes minutes (it is not "initializing").
						transcribeStarted = true;
						stopTicker();
						const startedAt = Date.now();
						broadcastProgress({
							phase: "transcribing",
							detail:
								"Transcribing your video — this can take a few minutes on a long video...",
						});
						ticker = setInterval(() => {
							const sec = Math.round((Date.now() - startedAt) / 1000);
							broadcastProgress({
								phase: "transcribing",
								detail: `Transcribing your video — ${sec}s elapsed (long videos take a few minutes)...`,
							});
						}, 1000);
					}
				},
			});
			const segments: TranscriptSegmentLite[] = transcript.segments.map(
				(s) => ({ start: s.start, end: s.end, text: s.text }),
			);
			const words: TranscriptWordLite[] | undefined = transcript.words?.map(
				(word) => ({ start: word.start, end: word.end, text: word.text }),
			);
			// Only flag words-unavailable when words were actually wanted — so a
			// plain segment-level run never poisons a later word-level request.
			const wordsUnavailable = wantWords
				? transcript.wordsUnavailable ?? !words
				: undefined;
			writeCache(projectId, {
				hash,
				segments,
				words,
				wordsUnavailable,
				createdAt: Date.now(),
			});
			return { segments, words, wordsUnavailable };
		} finally {
			stopTicker();
		}
	};

	inFlightHasWords = wantWords;
	inFlight = run().finally(() => {
		inFlight = null;
		inFlightHash = null;
		inFlightHasWords = false;
		lastProgress = null;
	});
	inFlightHash = hash;
	try {
		const result = await abortable(inFlight);
		return { ...result, fromCache: false };
	} finally {
		if (onProgress) progressSubscribers.delete(onProgress);
	}
}
