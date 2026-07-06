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
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	/** Long-export alternative to audioBuffer: sequential mix windows (P0.4).
	 * mediabunny timestamps consecutive add() calls back to back, so feeding
	 * chunks is equivalent to one giant buffer without the giant allocation. */
	audioChunks?: AsyncIterable<AudioBuffer>;
	/** Encoder config for the chunked path (normally read off audioBuffer). */
	audioFormat?: { sampleRate: number; numberOfChannels: number };
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

/** Chromium reports "prefer-hardware" configs as UNSUPPORTED when no GPU
 * encoder exists (headless, VMs, some laptops on battery) rather than falling
 * back to software — which failed the whole export. Probe a representative
 * config once and only ask for hardware when it's actually there. */
async function resolveHardwareAcceleration({
	codec,
	width,
	height,
}: {
	codec: "vp9" | "avc";
	width: number;
	height: number;
}): Promise<"prefer-hardware" | "no-preference"> {
	if (typeof VideoEncoder === "undefined") return "no-preference";
	try {
		const { supported } = await VideoEncoder.isConfigSupported({
			codec: codec === "vp9" ? "vp09.00.10.08" : "avc1.42001f",
			width,
			height,
			// Representative probe bitrate; hw presence doesn't hinge on it.
			bitrate: 1_000_000,
			hardwareAcceleration: "prefer-hardware",
		});
		if (supported) return "prefer-hardware";
	} catch {
		// fall through to software
	}
	return "no-preference";
}

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
	private audioChunks?: AsyncIterable<AudioBuffer>;
	private audioFormat?: { sampleRate: number; numberOfChannels: number };

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
		audioFormat,
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
		this.audioFormat = audioFormat;
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

		const videoCodec = this.format === "webm" ? "vp9" : "avc";
		const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
			codec: videoCodec,
			bitrate: qualityMap[this.quality],
			// Use the GPU's hardware video encoder (NVENC/QSV/AMF/VideoToolbox)
			// when available — typically several times faster than software
			// encode. Chromium treats "prefer-hardware" as unsupported on
			// GPU-less machines (VMs, headless) instead of falling back, which
			// used to fail the whole export — probe first and drop the hint
			// when no hardware encoder exists.
			hardwareAcceleration: await resolveHardwareAcceleration({
				codec: videoCodec,
				width: this.renderer.getOutputCanvas().width,
				height: this.renderer.getOutputCanvas().height,
			}),
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		const audioConfig = this.audioBuffer
			? {
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
				}
			: this.audioFormat;
		if (this.shouldIncludeAudio && (this.audioBuffer || this.audioChunks) && audioConfig) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: audioConfig.sampleRate,
					numberOfChannels: audioConfig.numberOfChannels,
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
			if (this.audioChunks) {
				// Chunked long-export path: sequential windows, each timestamped
				// after the previous by mediabunny. Peak memory = one window.
				for await (const chunk of this.audioChunks) {
					if (this.isCancelled) break;
					await audioSource.add(chunk);
				}
			} else if (this.audioBuffer) {
				await audioSource.add(this.audioBuffer);
			}
			audioSource.close();
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
