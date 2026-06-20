import type {
	AudioElement,
	VideoElement,
	LibraryAudioElement,
	RetimeConfig,
	SceneTracks,
} from "@/timeline";
import { shouldMaintainPitch } from "@/retime/rate";
import type { MediaAsset } from "@/media/types";
import { applyAudioMasteringToBuffer } from "@/media/audio-mastering";
import type { AudioCapableElement } from "@/timeline/audio-state";
import {
	hasAnimatedVolume,
	isElementMuted,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { doesElementHaveEnabledAudio } from "@/timeline/audio-separation";
import { canElementHaveAudio, hasMediaId } from "@/timeline/element-utils";
import { canTrackHaveAudio } from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";
import { TICKS_PER_SECOND } from "@/wasm";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { StreamingLinearResampler } from "./streaming-resampler";
import { timelineAudioFrameCount } from "./timeline-audio-size";
import {
	computeRmsBuckets,
	type SampleBucket,
} from "@/media/waveform-summary";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

export interface CollectedAudioElement {
	timelineElement: AudioCapableElement;
	buffer: AudioBuffer;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
	sampleRate,
}: {
	audioBlob: Blob;
	sampleRate?: number;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext({ sampleRate });
	const arrayBuffer = await audioBlob.arrayBuffer();
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

	// mix down to mono
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const samples = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let channel = 0; channel < numChannels; channel++) {
			sum += audioBuffer.getChannelData(channel)[i];
		}
		samples[i] = sum / numChannels;
	}

	return { samples, sampleRate: audioBuffer.sampleRate };
}

export interface AudibleElementCandidate {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
}

export function collectAudibleCandidates({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): AudibleElementCandidate[] {
	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mediaMap = new Map(mediaAssets.map((a) => [a.id, a]));
	const candidates: AudibleElementCandidate[] = [];

	for (const track of allTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			candidates.push({ element, mediaAsset });
		}
	}

	return candidates;
}

export function timelineHasAudio({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): boolean {
	return collectAudibleCandidates({ tracks, mediaAssets }).some(
		({ element }) => !isElementMuted({ element }),
	);
}

export async function collectAudioElements({
	tracks,
	mediaAssets,
	audioContext,
	onDecodeProgress,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	audioContext: AudioContext;
	/** Fires 0..1 as each asset finishes decoding (export progress feedback). */
	onDecodeProgress?: (fraction: number) => void;
}): Promise<CollectedAudioElement[]> {
	const candidates = collectAudibleCandidates({ tracks, mediaAssets });
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((media) => [media.id, media]),
	);
	const pendingElements: Array<Promise<CollectedAudioElement | null>> = [];

	// Decode each source asset's audio AT MOST ONCE. A silence-removed clip becomes
	// many timeline elements that all reference the same asset; decoding the full
	// asset buffer per element (in parallel, via Promise.all below) exhausts memory
	// on long videos — "Array buffer allocation failed" / createBuffer NotSupported.
	// The decoded buffer is shared READ-ONLY by the mix (mixAudioChannels reads the
	// source into the output; renderRetimedBuffer returns a new buffer), so one
	// decode safely serves every element referencing that asset. (See PATCHES.md.)
	const assetBufferCache = new Map<string, Promise<AudioBuffer | null>>();
	const resolveAsset = ({ asset }: { asset: MediaAsset }): Promise<AudioBuffer | null> => {
		let cached = assetBufferCache.get(asset.id);
		if (!cached) {
			cached = resolveAudioBufferForAsset({ asset, audioContext });
			assetBufferCache.set(asset.id, cached);
		}
		return cached;
	};

	for (const { element, mediaAsset } of candidates) {
		if (element.type === "audio") {
			pendingElements.push(
				resolveAudioBufferForElement({
					element,
					mediaMap,
					audioContext,
					resolveAsset,
				}).then((audioBuffer) => {
					if (!audioBuffer) return null;
					return {
						timelineElement: element,
						buffer: audioBuffer,
						startTime: element.startTime / TICKS_PER_SECOND,
						duration: element.duration / TICKS_PER_SECOND,
						trimStart: element.trimStart / TICKS_PER_SECOND,
						trimEnd: element.trimEnd / TICKS_PER_SECOND,
						volume: resolveEffectiveAudioGain({
							element,
							trackMuted: false,
							localTime: 0,
						}),
						muted: isElementMuted({ element }),
						retime: element.retime,
					};
				}),
			);
			continue;
		}

		if (element.type === "video") {
			if (!mediaAsset || !mediaSupportsAudio({ media: mediaAsset })) continue;

			pendingElements.push(
				resolveAsset({ asset: mediaAsset }).then((audioBuffer) => {
					if (!audioBuffer) return null;
					return {
						timelineElement: element,
						buffer: audioBuffer,
						startTime: element.startTime / TICKS_PER_SECOND,
						duration: element.duration / TICKS_PER_SECOND,
						trimStart: element.trimStart / TICKS_PER_SECOND,
						trimEnd: element.trimEnd / TICKS_PER_SECOND,
						volume: resolveEffectiveAudioGain({
							element,
							trackMuted: false,
							localTime: 0,
						}),
						muted: isElementMuted({ element }),
						retime: element.retime,
					};
				}),
			);
		}
	}

	const total = pendingElements.length;
	let settled = 0;
	const tracked = pendingElements.map((pending) =>
		pending.finally(() => {
			settled++;
			if (total > 0) onDecodeProgress?.(settled / total);
		}),
	);
	const resolvedElements = await Promise.all(tracked);
	const audioElements: CollectedAudioElement[] = [];
	for (const element of resolvedElements) {
		if (element) audioElements.push(element);
	}
	return audioElements;
}

async function resolveAudioBufferForElement({
	element,
	mediaMap,
	audioContext,
	resolveAsset,
}: {
	element: AudioElement;
	mediaMap: Map<string, MediaAsset>;
	audioContext: AudioContext;
	/** Per-asset cached decode (collectAudioElements) — dedupes same-asset elements. */
	resolveAsset: (args: { asset: MediaAsset }) => Promise<AudioBuffer | null>;
}): Promise<AudioBuffer | null> {
	try {
		if (element.sourceType === "upload") {
			const asset = mediaMap.get(element.mediaId);
			if (!asset) return null;
			return await resolveAsset({ asset });
		}

		if (element.buffer) return element.buffer;

		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return await audioContext.decodeAudioData(arrayBuffer.slice(0));
	} catch (error) {
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForAsset({
	asset,
	audioContext,
}: {
	asset: MediaAsset;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
	if (asset.type === "audio") {
		try {
			const arrayBuffer = await asset.file.arrayBuffer();
			return await audioContext.decodeAudioData(arrayBuffer.slice(0));
		} catch (error) {
			console.warn("Failed to decode audio asset:", error);
			return null;
		}
	}

	const input = new Input({
		source: new BlobSource(asset.file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const sink = new AudioBufferSink(audioTrack);
		const targetSampleRate = audioContext.sampleRate;

		// Heavy-downsample ANALYSIS path (→16kHz mono for transcription/silence):
		// stream-resample each chunk straight into the output so a long source never
		// holds its full native PCM (the prior ~3× hold OOM'd a 16-min recording at
		// "Extracting timeline audio"). The export path (higher target rate) keeps
		// the offline render below for quality.
		if (targetSampleRate <= DEFAULT_TRANSCRIPTION_SAMPLE_RATE) {
			return await streamResampleTrack({ input, sink, audioContext, targetSampleRate });
		}

		const chunks: AudioBuffer[] = [];
		let totalSamples = 0;

		for await (const { buffer } of sink.buffers(0)) {
			chunks.push(buffer);
			totalSamples += buffer.length;
		}

		if (chunks.length === 0) return null;

		const nativeSampleRate = chunks[0].sampleRate;
		const numChannels = Math.min(
			MAX_AUDIO_CHANNELS,
			chunks[0].numberOfChannels,
		);

		const nativeChannels = Array.from(
			{ length: numChannels },
			() => new Float32Array(totalSamples),
		);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < numChannels; channel++) {
				const sourceData = chunk.getChannelData(
					Math.min(channel, chunk.numberOfChannels - 1),
				);
				nativeChannels[channel].set(sourceData, offset);
			}
			offset += chunk.length;
		}

		// use OfflineAudioContext for high-quality resampling to target rate
		const outputSamples = Math.ceil(
			totalSamples * (targetSampleRate / nativeSampleRate),
		);
		const offlineContext = new OfflineAudioContext(
			numChannels,
			outputSamples,
			targetSampleRate,
		);

		const nativeBuffer = audioContext.createBuffer(
			numChannels,
			totalSamples,
			nativeSampleRate,
		);
		for (let ch = 0; ch < numChannels; ch++) {
			nativeBuffer.copyToChannel(nativeChannels[ch], ch);
		}

		const sourceNode = offlineContext.createBufferSource();
		sourceNode.buffer = nativeBuffer;
		sourceNode.connect(offlineContext.destination);
		sourceNode.start(0);

		return await offlineContext.startRendering();
	} catch (error) {
		console.warn("Failed to decode asset audio:", error);
		return null;
	} finally {
		input.dispose();
	}
}

/** A few samples of slack on the pre-sized resample output for rounding. */
const RESAMPLE_OUTPUT_SLACK = 16;

/**
 * Stream a track's audio through a linear resampler, writing each decoded chunk
 * straight into the pre-sized output — never holding the full native PCM. Output
 * length is pre-sized from the track duration (the resampler clamps to it).
 */
async function streamResampleTrack({
	input,
	sink,
	audioContext,
	targetSampleRate,
}: {
	input: Input;
	sink: AudioBufferSink;
	audioContext: AudioContext;
	targetSampleRate: number;
}): Promise<AudioBuffer | null> {
	const durationSec = await input.computeDuration();
	let resampler: StreamingLinearResampler | null = null;
	let numChannels = 0;
	for await (const { buffer } of sink.buffers(0)) {
		if (!resampler) {
			numChannels = Math.min(MAX_AUDIO_CHANNELS, buffer.numberOfChannels);
			const maxOutputSamples =
				Math.ceil(durationSec * targetSampleRate) + RESAMPLE_OUTPUT_SLACK;
			resampler = new StreamingLinearResampler({
				nativeRate: buffer.sampleRate,
				targetRate: targetSampleRate,
				numChannels,
				maxOutputSamples,
			});
		}
		const channels = Array.from({ length: numChannels }, (_, channel) =>
			buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)),
		);
		resampler.push({ channels, length: buffer.length });
	}
	if (!resampler || resampler.outputLength === 0) return null;
	const output = resampler.finish();
	const outBuffer = audioContext.createBuffer(
		numChannels,
		output[0].length,
		targetSampleRate,
	);
	for (let channel = 0; channel < numChannels; channel++) {
		// `.set` (not copyToChannel) sidesteps the strict Float32Array<ArrayBuffer>
		// vs <ArrayBufferLike> mismatch on the resampler's subarray views.
		outBuffer.getChannelData(channel).set(output[channel]);
	}
	return outBuffer;
}

interface AudioMixSource {
	timelineElement: AudioCapableElement;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	retime?: RetimeConfig;
}

export interface AudioClipSource {
	timelineElement: AudioCapableElement;
	id: string;
	sourceKey: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

async function fetchLibraryAudioSource({
	element,
	volume,
}: {
	element: LibraryAudioElement;
	volume: number;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineElement: element,
			file,
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
	volume,
}: {
	element: LibraryAudioElement;
	muted: boolean;
	volume: number;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineElement: element,
			id: element.id,
			sourceKey: element.id,
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			volume,
			muted,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	element,
	mediaAsset,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	volume: number;
}): AudioMixSource {
	return {
		timelineElement: element,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		retime: element.retime,
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	muted: boolean;
	volume: number;
}): AudioClipSource {
	return {
		timelineElement: element,
		id: element.id,
		sourceKey: mediaAsset.id,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		muted,
		retime: element.retime,
	};
}

export async function collectAudioMixSources({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<AudioMixSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of orderedTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (isElementMuted({ element })) continue;
			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;
			const volume = resolveEffectiveAudioGain({
				element,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				} else {
					pendingLibrarySources.push(
						fetchLibraryAudioSource({ element, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClips({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<AudioClipSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of orderedTracks) {
		const isTrackMuted = canTrackHaveAudio(track) && track.muted;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			const muted = isTrackMuted || isElementMuted({ element });
			const volume = resolveEffectiveAudioGain({
				element,
				trackMuted: isTrackMuted,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({ element, muted, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	outputChannels = 2,
	audioContext,
	onProgress,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	/** Output channel count. Export uses 2 (stereo); the analysis/transcription
	 * path passes 1 (mono) — together with a lower sampleRate this keeps the
	 * buffer small enough that `createBuffer` doesn't reject a long timeline. */
	outputChannels?: number;
	audioContext?: AudioContext;
	/** Fires 0..1 across decode → mix → mastering, so the export bar moves
	 * during this stage instead of looking frozen. */
	onProgress?: (fraction: number) => void;
}): Promise<AudioBuffer | null> {
	const context = audioContext ?? createAudioContext({ sampleRate });

	// Decoding every asset is the slow part — give it the bulk of the bar.
	const audioElements = await collectAudioElements({
		tracks,
		mediaAssets,
		audioContext: context,
		onDecodeProgress: (fraction) => onProgress?.(fraction * 0.7),
	});

	if (audioElements.length === 0) return null;

	const durationSeconds = duration / TICKS_PER_SECOND;
	const outputLength = timelineAudioFrameCount({
		durationTicks: duration,
		sampleRate,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	let outputBuffer: AudioBuffer;
	try {
		outputBuffer = context.createBuffer(outputChannels, outputLength, sampleRate);
	} catch (error) {
		// A long enough timeline overflows the browser's createBuffer allocation
		// limit (~21 min stereo @ 44.1kHz ≈ 459 MB). Surface an actionable message
		// instead of the raw "createBuffer(...) failed" DOMException.
		const minutes = Math.max(1, Math.round(durationSeconds / 60));
		throw new Error(
			`Timeline audio is too large to process in one buffer (~${minutes} min, ${outputChannels}ch @ ${sampleRate}Hz). Shorten the timeline or split the export. (createBuffer failed: ${error instanceof Error ? error.message : String(error)})`,
		);
	}

	let mixed = 0;
	for (const element of audioElements) {
		if (!element.muted) {
			const renderedBuffer = shouldMaintainPitch({
				rate: element.retime?.rate ?? 1,
				maintainPitch: element.retime?.maintainPitch,
			})
				? await renderRetimedBuffer({
						audioContext: context,
						sourceBuffer: element.buffer,
						trimStart: element.trimStart,
						clipDuration: element.duration,
						retime: element.retime,
						maintainPitch: true,
					})
				: undefined;

			mixAudioChannels({
				element,
				buffer: renderedBuffer ?? element.buffer,
				trimStart: renderedBuffer ? 0 : element.trimStart,
				retime: renderedBuffer ? undefined : element.retime,
				outputBuffer,
				outputLength,
				sampleRate,
			});
		}
		mixed++;
		// Mixing spans 0.7 → 0.95 of the audio stage.
		onProgress?.(0.7 + (mixed / audioElements.length) * 0.25);
	}

	onProgress?.(0.95);
	const mastered = await applyAudioMasteringToBuffer({
		audioBuffer: outputBuffer,
	});
	onProgress?.(1);
	return mastered;
}

function collectPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): Float32Array {
	const channels = buffer.numberOfChannels;
	const peaks = new Float32Array(count);

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < count; i++) {
			const { bucketStart: start, bucketEnd: end } = getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex: i,
				bucketCount: count,
			});
			for (let j = start; j < end; j++) {
				const abs = Math.abs(data[j]);
				if (abs > peaks[i]) peaks[i] = abs;
			}
		}
	}

	return peaks;
}

export function extractPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return Array.from(
		collectPeakRange({
			buffer,
			count,
			startSample,
			endSample,
		}),
	);
}

export function getSampleBucketRange({
	startSample,
	endSample,
	bucketIndex,
	bucketCount,
}: {
	startSample: number;
	endSample: number;
	bucketIndex: number;
	bucketCount: number;
}): {
	bucketStart: number;
	bucketEnd: number;
} {
	const rangeLength = Math.max(0, endSample - startSample);
	const bucketStart =
		startSample + Math.floor((bucketIndex * rangeLength) / bucketCount);
	const bucketEnd =
		startSample + Math.floor(((bucketIndex + 1) * rangeLength) / bucketCount);
	return {
		bucketStart,
		bucketEnd: Math.max(bucketStart, bucketEnd),
	};
}

export function extractRmsBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	return computeRmsBuckets({ buffer, buckets });
}

/**
 * Computes per-bucket waveform amplitude using the maximum RMS over a short
 * analysis window inside each bucket.
 *
 * A naive mean-RMS over a whole bucket averages silence together with nearby
 * sound, which smears transitions (e.g. the onset of speech) across the
 * bucket and makes the waveform respond late. Taking the max over fixed
 * short windows (~20 ms) preserves the smooth, non-jittery RMS character
 * while making transitions land where they actually happen in the audio.
 *
 * Channels are combined per-window before taking the max, so the measure
 * reflects total energy regardless of stereo layout.
 */
export function extractRmsRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return extractRmsBuckets({
		buffer,
		buckets: Array.from({ length: count }, (_, bucketIndex) =>
			getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex,
				bucketCount: count,
			}),
		),
	});
}

function mixAudioChannels({
	element,
	buffer,
	trimStart,
	retime,
	outputBuffer,
	outputLength,
	sampleRate,
}: {
	element: CollectedAudioElement;
	buffer: AudioBuffer;
	trimStart: number;
	retime?: RetimeConfig;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
}): void {
	const { startTime, duration: elementDuration } = element;

	const outputStartSample = Math.floor(startTime * sampleRate);
	const renderedLength = Math.ceil(elementDuration * sampleRate);

	// Follow the output buffer's channel count: 2 for export (stereo), 1 for the
	// mono analysis path. A source channel beyond the output folds to the last.
	const outputChannels = outputBuffer.numberOfChannels;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);

		for (let i = 0; i < renderedLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex >= outputLength) break;

			const clipTime = i / sampleRate;
			const sourceTime =
				trimStart + getSourceTimeAtClipTime({ clipTime, retime });
			const sourceIndex = sourceTime * buffer.sampleRate;
			if (sourceIndex >= sourceData.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(sourceData.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;
			const gain = hasAnimatedVolume({ element: element.timelineElement })
				? resolveEffectiveAudioGain({
						element: element.timelineElement,
						localTime: clipTime,
					})
				: element.volume;
			outputData[outputIndex] +=
				(sourceData[lowerIndex] * (1 - fraction) +
					sourceData[upperIndex] * fraction) *
				gain;
		}
	}
}
