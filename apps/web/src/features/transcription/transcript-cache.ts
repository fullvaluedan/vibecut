/**
 * One transcript, used everywhere. The timeline's audio content is hashed
 * (asset ids + placement + trims); the transcript for that exact state is
 * cached on this device and shared by AI CUT, RUN HYPERFRAMES, and the
 * background transcriber that kicks in whenever the timeline changes.
 */

import { create } from "zustand";
import type { EditorCore } from "@/core";
import { decodeAudioToFloat32 } from "@/media/audio";
import { encodeAudioForUpload } from "@/media/audio-encode";
import { extractTimelineAudio } from "@/media/mediabunny";
import { transcriptionService } from "@/services/transcription/service";
import { vadService } from "@/services/vad/service";
import { concatSpeechSamples, remapBufferTimes, type ConcatSegment } from "./vad-remap";
import {
	buildTranscribeHeaders,
	useAiSettingsStore,
} from "@/features/ai-generate/store";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { selectAnalysisModel } from "@/transcription/analysis-model";
import { TICKS_PER_SECOND } from "@/wasm";
import { needsWordUpgrade } from "./word-upgrade";

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

/**
 * The cached WORD-level timings for the current timeline, or `[]` when none are
 * cached (segment-only entry, a words-unavailable device model, or no cache at
 * all). Read-only + non-blocking — never triggers a transcription. Word-timing
 * consumers (e.g. standalone Remove Silences' emphasis-pause protection) need the
 * per-WORD boundaries the pause classifier is calibrated for; segment boundaries
 * span whole sentences and swallow in-dialog pauses, so a segment-only fallback
 * degrades safely but rarely protects a pause.
 */
export function getCachedWords(editor: EditorCore): TranscriptWordLite[] {
	return getCachedEntry(editor)?.words ?? [];
}

let inFlight: Promise<{
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
	wordsUnavailable?: boolean;
}> | null = null;
let inFlightHash: string | null = null;

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
export function parseCloudTranscript(payload: unknown): {
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

	// Join any in-flight run for the SAME timeline instead of starting a second
	// one: two concurrent runs would each extract the timeline audio (racing
	// mediabunny) and the later one would overwrite `inFlight`, so the first run's
	// cleanup would later strand it. A cloud run always returns words, so a
	// word-level caller that joins it is satisfied immediately. Only when the joined
	// run produced no words (a segment-only local run) do we fall through to our own
	// run — and by then the joined run has settled, so the two never extract at once.
	if (inFlight && inFlightHash === hash) {
		const current = inFlight;
		let joined: Awaited<typeof current>;
		try {
			joined = await abortable(current);
		} catch (error) {
			if (onProgress) progressSubscribers.delete(onProgress);
			throw error;
		}
		if (!needsWordUpgrade({ wantWords, result: joined })) {
			if (onProgress) progressSubscribers.delete(onProgress);
			return { ...joined, fromCache: false };
		}
		// Needed words, the joined run had none: fall through to our own run.
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
				detail: "Preparing audio for the cloud transcriber...",
			});
			const cloudTicker = setInterval(() => {
				const sec = Math.round((Date.now() - startedAt) / 1000);
				broadcastProgress({
					phase: "transcribing",
					detail: `Transcribing in the cloud - ${sec}s elapsed...`,
				});
			}, 1000);
			try {
				// Compress to a small Opus/AAC blob so a long source stays under
				// Groq's 100 MB cap; fall back to the WAV if the browser can't encode.
				const encoded = await encodeAudioForUpload({ audioBlob });
				const upload = encoded ?? {
					blob: audioBlob,
					filename: "timeline.wav",
				};
				const form = new FormData();
				form.append("audio", upload.blob, upload.filename);
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

		const { samples, sampleRate } = await decodeAudioToFloat32({
			audioBlob,
			sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
		});

		// VAD-gated transcription (Plan A / U4, OPT-IN — default off): transcribe ONLY
		// the speech (silence never reaches Whisper → faster, no silence hallucination
		// on long sources). Times come back in concatenated-buffer time and are remapped
		// to timeline-absolute below. Falls back to the full audio if VAD is off OR
		// fails — so it can never make a transcription worse than today.
		let audioData = samples;
		let remapSegments: ConcatSegment[] | null = null;
		if (useAiSettingsStore.getState().directorVadGatedTranscriptionEnabled) {
			try {
				// abortable() so a cancel (or the worker's watchdog timeout) interrupts
				// the VAD pass instead of the pipeline waiting on it indefinitely.
				const { speech } = await abortable(
					vadService.detectSpeechGaps({
						samples,
						sampleRate,
						totalSec: totalDuration / TICKS_PER_SECOND,
					}),
				);
				if (speech.length > 0) {
					const { buffer, segments } = concatSpeechSamples({
						samples,
						sampleRate,
						speech,
					});
					if (buffer.length > 0) {
						audioData = buffer;
						remapSegments = segments;
					}
				}
			} catch (error) {
				// Honor a real cancel — don't swallow it into a full transcription.
				if (signal?.aborted) throw error;
				// VAD unavailable / failed — transcribe the full audio (unchanged).
			}
		}

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
				audioData,
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
										detail: `Initializing speech model - ${sec}s elapsed (first run can take about a minute; later runs are instant)...`,
										progress: 1,
									});
								}, 1000);
								broadcastProgress({
									phase: "initializing-model",
									detail:
										"Speech model downloaded - initializing (first run can take about a minute)...",
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
								"Transcribing your video - this can take a few minutes on a long video...",
						});
						ticker = setInterval(() => {
							const sec = Math.round((Date.now() - startedAt) / 1000);
							broadcastProgress({
								phase: "transcribing",
								detail: `Transcribing your video - ${sec}s elapsed (long videos take a few minutes)...`,
							});
						}, 1000);
					}
				},
			});
			const rawSegments = transcript.segments.map((s) => ({
				start: s.start,
				end: s.end,
				text: s.text,
			}));
			const rawWords = transcript.words?.map((word) => ({
				start: word.start,
				end: word.end,
				text: word.text,
			}));
			// VAD-gated runs return buffer-time; remap back to timeline-absolute. A
			// full-audio run (remapSegments null) passes the times through unchanged.
			const segments: TranscriptSegmentLite[] = remapSegments
				? remapBufferTimes({ times: rawSegments, segments: remapSegments })
				: rawSegments;
			const words: TranscriptWordLite[] | undefined = rawWords
				? remapSegments
					? remapBufferTimes({ times: rawWords, segments: remapSegments })
					: rawWords
				: undefined;
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

	const thisRun = run();
	inFlight = thisRun;
	inFlightHash = hash;
	// Clear the shared slot only if it STILL points at this run. A newer run for a
	// different timeline may have replaced it; nulling then would strand that run
	// and wipe its live progress, freezing a joiner's bar on a dead ticker.
	const releaseSlot = () => {
		if (inFlight === thisRun) {
			inFlight = null;
			inFlightHash = null;
			lastProgress = null;
		}
	};
	// Attach cleanup as BOTH handlers (not `.finally`): a rejected run (e.g. a
	// cancelled one) then does not surface as an unhandled promise rejection. The
	// caller still observes the rejection through `await abortable(thisRun)` below.
	void thisRun.then(releaseSlot, releaseSlot);
	try {
		const result = await abortable(thisRun);
		return { ...result, fromCache: false };
	} finally {
		if (onProgress) progressSubscribers.delete(onProgress);
	}
}
