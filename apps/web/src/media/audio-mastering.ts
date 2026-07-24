const MASTER_LIMITER_THRESHOLD_DB = -1;
const MASTER_LIMITER_KNEE_DB = 0;
const MASTER_LIMITER_RATIO = 20;
const MASTER_LIMITER_ATTACK_SECONDS = 0.001;
const MASTER_LIMITER_RELEASE_SECONDS = 0.12;
export const MASTER_OUTPUT_HEADROOM = 0.98;

export function getAudioBufferPeak({
	audioBuffer,
}: {
	audioBuffer: AudioBuffer;
}): number {
	let peak = 0;

	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			const magnitude = Math.abs(channelData[index]);
			if (magnitude > peak) {
				peak = magnitude;
			}
		}
	}

	return peak;
}

export function createAudioMasteringChain({
	audioContext,
	destination,
}: {
	audioContext: AudioContext | OfflineAudioContext;
	destination: AudioNode;
}): {
	input: GainNode;
} {
	const input = audioContext.createGain();
	const limiter = audioContext.createDynamicsCompressor();
	const outputGain = audioContext.createGain();

	limiter.threshold.value = MASTER_LIMITER_THRESHOLD_DB;
	limiter.knee.value = MASTER_LIMITER_KNEE_DB;
	limiter.ratio.value = MASTER_LIMITER_RATIO;
	limiter.attack.value = MASTER_LIMITER_ATTACK_SECONDS;
	limiter.release.value = MASTER_LIMITER_RELEASE_SECONDS;
	outputGain.gain.value = MASTER_OUTPUT_HEADROOM;

	input.connect(limiter);
	limiter.connect(outputGain);
	outputGain.connect(destination);

	return { input };
}

export async function applyAudioMasteringToBuffer({
	audioBuffer,
}: {
	audioBuffer: AudioBuffer;
}): Promise<AudioBuffer> {
	if (getAudioBufferPeak({ audioBuffer }) <= MASTER_OUTPUT_HEADROOM) {
		return audioBuffer;
	}

	const offlineContext = new OfflineAudioContext(
		audioBuffer.numberOfChannels,
		Math.max(1, audioBuffer.length),
		audioBuffer.sampleRate,
	);
	const source = offlineContext.createBufferSource();
	source.buffer = audioBuffer;

	const { input } = createAudioMasteringChain({
		audioContext: offlineContext,
		destination: offlineContext.destination,
	});
	source.connect(input);
	source.start(0);

	const renderedBuffer = await offlineContext.startRendering();
	clampAudioBufferPeak({
		audioBuffer: renderedBuffer,
		maxPeak: MASTER_OUTPUT_HEADROOM,
	});
	return renderedBuffer;
}

/**
 * The single, seam-free master gain the chunked export applies uniformly to
 * every 60s window. `peak` is the loudest sample across the WHOLE timeline.
 * Below the headroom ceiling the master limiter is a pass-through, so the
 * chunked mix must be too (gain 1, byte-identical to the single-buffer path);
 * above it, one scalar brings the loudest sample down to the ceiling. Because
 * it is the same scalar for every window, the gain is identical on both sides
 * of every window seam - unlike a per-window compressor, whose attack/release
 * state resets at each seam and steps the loudness.
 */
export function masterGainForPeak({ peak }: { peak: number }): number {
	return peak > MASTER_OUTPUT_HEADROOM ? MASTER_OUTPUT_HEADROOM / peak : 1;
}

/** Multiply every sample of every channel by `gain`, in place. A gain of 1 is a
 * no-op (the sub-threshold pass-through case), so it skips the whole scan. */
export function applyGainToAudioBuffer({
	audioBuffer,
	gain,
}: {
	audioBuffer: AudioBuffer;
	gain: number;
}): void {
	if (gain === 1) return;
	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			channelData[index] *= gain;
		}
	}
}

function clampAudioBufferPeak({
	audioBuffer,
	maxPeak,
}: {
	audioBuffer: AudioBuffer;
	maxPeak: number;
}): void {
	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			channelData[index] = Math.max(
				-maxPeak,
				Math.min(maxPeak, channelData[index]),
			);
		}
	}
}
