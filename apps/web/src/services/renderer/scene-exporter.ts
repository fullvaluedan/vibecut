import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import type { TimelineAudioChunk } from "@/media/audio";
import { CanvasRenderer } from "./canvas-renderer";

/**
 * A long timeline can't be mixed into one `AudioBuffer` (the `createBuffer`
 * wall), so the audio is streamed to the encoder as a sequence of mastered
 * windows instead. The encoder is configured from `sampleRate` / channel count
 * up front, then each chunk is added in order.
 */
export type AudioChunkStream = {
	sampleRate: number;
	numberOfChannels: number;
	chunks: AsyncIterable<TimelineAudioChunk>;
};

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	/** Whole-timeline mix (short timelines). Mutually exclusive with `audioChunks`. */
	audioBuffer?: AudioBuffer;
	/** Streamed window mix (long timelines). Mutually exclusive with `audioBuffer`. */
	audioChunks?: AudioChunkStream;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private audioChunks?: AudioChunkStream;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		audioChunks,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.audioChunks = audioChunks;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
			// Use the GPU's hardware video encoder (NVENC/QSV/AMF/VideoToolbox)
			// when available — typically several times faster than software
			// encode. Falls back to software automatically where unsupported.
			hardwareAcceleration: "prefer-hardware",
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		// One whole-timeline buffer (short) OR a stream of window buffers (long) -
		// exactly one is set. Read the sample rate / channel count from whichever
		// is present so the encoder is configured the same way for both.
		const audioInfo = this.audioBuffer
			? {
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
				}
			: this.audioChunks
				? {
						sampleRate: this.audioChunks.sampleRate,
						numberOfChannels: this.audioChunks.numberOfChannels,
					}
				: null;

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && audioInfo) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: audioInfo.sampleRate,
					numberOfChannels: audioInfo.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource) {
			if (this.audioBuffer) {
				await audioSource.add(this.audioBuffer);
			} else if (this.audioChunks) {
				// Add each mastered window in order. `add` places every buffer right
				// after the previous one, so the windows reassemble into a gapless
				// track; awaiting each add respects encoder/writer backpressure so
				// only one window is ever in flight.
				for await (const { buffer } of this.audioChunks.chunks) {
					if (this.isCancelled) break;
					await audioSource.add(buffer);
				}
			}
			audioSource.close();
		}

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			await this.renderer.render({ node: rootNode, time: timeTicks });
			await videoSource.add(timeSeconds, 1 / fpsFloat);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		const buffer = output.target.buffer;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", buffer);
		return buffer;
	}
}
