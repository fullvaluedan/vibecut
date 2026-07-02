/**
 * Compress the 16 kHz-mono transcription WAV to a small Opus (preferred) or AAC
 * blob before cloud upload, so a long source stays well under Groq's 100 MB cap
 * (an hour of speech is single-digit MB vs ~115 MB as WAV). Browser-only,
 * reuses mediabunny (already a dependency) + WebCodecs, no new package. Returns
 * null when the browser can't encode either codec; the caller uploads the WAV.
 */

import {
	Output,
	BufferTarget,
	WebMOutputFormat,
	Mp4OutputFormat,
	AudioBufferSource,
} from "mediabunny";
import { decodeAudioToFloat32 } from "@/media/audio";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import {
	CODEC_PREFERENCE,
	encoderProbe,
	uploadInfoForCodec,
	type UploadCodec,
} from "@/media/audio-encode-codecs";

/** First codec WebCodecs can actually encode here, in preference order. */
async function pickEncodableCodec({
	sampleRate,
	numberOfChannels,
}: {
	sampleRate: number;
	numberOfChannels: number;
}): Promise<UploadCodec | null> {
	if (typeof AudioEncoder === "undefined") return null;
	for (const codec of CODEC_PREFERENCE) {
		const { webCodec, bitrate } = encoderProbe(codec);
		try {
			const { supported } = await AudioEncoder.isConfigSupported({
				codec: webCodec,
				sampleRate,
				numberOfChannels,
				bitrate,
			});
			if (supported) return codec;
		} catch {
			// Probe threw for this codec; try the next.
		}
	}
	return null;
}

/**
 * Hard bound on the encode. mediabunny's WebCodecs pipeline (start / add /
 * finalize) can WEDGE rather than reject on some inputs, and `try/catch` only
 * catches rejections, so an unbounded await would hang the whole cloud
 * transcription before any upload. On timeout we return null and the caller uploads
 * the WAV instead (larger, but the request actually fires).
 */
const ENCODE_TIMEOUT_MS = 20_000;

export async function encodeAudioForUpload({
	audioBlob,
}: {
	audioBlob: Blob;
}): Promise<{ blob: Blob; filename: string } | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ENCODE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([encodeAudioCore({ audioBlob }), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function encodeAudioCore({
	audioBlob,
}: {
	audioBlob: Blob;
}): Promise<{ blob: Blob; filename: string } | null> {
	try {
		const { samples, sampleRate } = await decodeAudioToFloat32({
			audioBlob,
			sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
		});
		if (samples.length === 0) return null;

		const codec = await pickEncodableCodec({ sampleRate, numberOfChannels: 1 });
		if (!codec) return null;

		const audioBuffer = new AudioBuffer({
			numberOfChannels: 1,
			length: samples.length,
			sampleRate,
		});
		// Fresh ArrayBuffer-backed copy: copyToChannel requires Float32Array<ArrayBuffer>,
		// but decodeAudioToFloat32 returns the looser Float32Array<ArrayBufferLike>.
		audioBuffer.copyToChannel(new Float32Array(samples), 0);

		const { bitrate } = encoderProbe(codec);
		const output = new Output({
			format: codec === "opus" ? new WebMOutputFormat() : new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const audioSource = new AudioBufferSource({ codec, bitrate });
		output.addAudioTrack(audioSource);
		await output.start();
		await audioSource.add(audioBuffer);
		audioSource.close();
		await output.finalize();

		const buffer = output.target.buffer;
		if (!buffer) return null;
		const { filename, mimeType } = uploadInfoForCodec(codec);
		return { blob: new Blob([buffer], { type: mimeType }), filename };
	} catch {
		// Any encode failure degrades to the WAV upload path.
		return null;
	}
}
