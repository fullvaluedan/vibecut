"use client";

import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";
import { createAudioContext } from "@/media/audio";
import {
	buildSourceWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import { WaveformSummaryAccumulator } from "@/media/waveform-accumulator";

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

export class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.buildSummary({
			sourceKey,
			audioBuffer,
			sourceFile,
			audioUrl,
		}).catch((error) => {
			this.summaries.delete(sourceKey);
			throw error;
		});

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		// Uploaded files (incl. long video recordings): decode the audio track in
		// CHUNKS via mediabunny so a 16-min source builds a FULL-LENGTH summary.
		// `decodeAudioData` on the whole file truncates for long sources (it
		// returned only ~44s of a 16-min recording), which left every clip past
		// that point with a flat waveform.
		if (sourceFile) {
			const streamed = await this.summaryFromFile({ sourceKey, file: sourceFile });
			if (streamed) {
				return streamed;
			}
			// No decodable audio track via mediabunny → fall back to decodeAudioData.
			return this.summaryFromDecode({
				sourceKey,
				arrayBuffer: await sourceFile.arrayBuffer(),
			});
		}

		if (audioUrl) {
			const response = await fetch(audioUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch waveform source: ${response.status}`);
			}
			return this.summaryFromDecode({
				sourceKey,
				arrayBuffer: await response.arrayBuffer(),
			});
		}

		throw new Error(`No waveform source available for ${sourceKey}`);
	}

	/**
	 * Stream a file's audio track through mediabunny's `AudioBufferSink`, folding
	 * each decoded chunk into a peak-bucket accumulator — so a long source never
	 * materializes its full PCM (the cause of the truncated `decodeAudioData`
	 * buffer). Returns null when the file has no decodable audio track or the
	 * demux/decode fails, so the caller can fall back to `decodeAudioData`.
	 */
	private async summaryFromFile({
		sourceKey,
		file,
	}: {
		sourceKey: string;
		file: File;
	}): Promise<SourceWaveformSummary | null> {
		const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
		try {
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				return null;
			}
			const sink = new AudioBufferSink(audioTrack);
			const accumulator = new WaveformSummaryAccumulator();
			for await (const { buffer } of sink.buffers(0)) {
				const channels = Array.from(
					{ length: buffer.numberOfChannels },
					(_, channel) => buffer.getChannelData(channel),
				);
				accumulator.add({
					channels,
					length: buffer.length,
					sampleRate: buffer.sampleRate,
				});
			}
			return accumulator.hasSamples() ? accumulator.finish({ sourceKey }) : null;
		} catch (error) {
			// Non-fatal: fall back to the decodeAudioData path.
			console.warn("Streaming waveform decode failed; falling back:", error);
			return null;
		} finally {
			input.dispose();
		}
	}

	/** Whole-file decode fallback (short sources / formats mediabunny declines). */
	private async summaryFromDecode({
		sourceKey,
		arrayBuffer,
	}: {
		sourceKey: string;
		arrayBuffer: ArrayBuffer;
	}): Promise<SourceWaveformSummary> {
		const audioContext = createAudioContext();
		try {
			const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
			return buildSourceWaveformSummary({ sourceKey, buffer });
		} finally {
			void audioContext.close();
		}
	}
}

export const waveformCache = new WaveformCache();
