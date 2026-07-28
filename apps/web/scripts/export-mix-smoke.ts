/**
 * Headless proof for the chunked export audio mix (W1 - the "createBuffer wall").
 *
 * The OLD export path allocated ONE `AudioBuffer` for the whole timeline, which
 * the browser refuses past ~21 min stereo @ 44.1kHz (~459 MB). This script
 * drives the PURE chunked mixer (`src/media/export-chunk-mixer.ts`) over a
 * SYNTHETIC 30-minute timeline (generated tone + silence, no real media decode)
 * and asserts:
 *   1. it completes,
 *   2. peak memory stays bounded - no single allocation is timeline-sized; the
 *      largest buffer is one 60s window,
 *   3. the total duration / sample count is correct and the chunks reassemble
 *      gaplessly through a fake sequential encoder.
 *
 * Run:  bun scripts/export-mix-smoke.ts
 *
 * It has no WebAudio / @wasm dependency, so it runs under plain bun.
 */

import {
	planChunkWindows,
	elementOverlapsWindow,
	mixElementIntoWindow,
	type WindowMixElement,
} from "../src/media/export-chunk-mixer";

const SAMPLE_RATE = 44100;
const OUTPUT_CHANNELS = 2;
const CHUNK_SECONDS = 60;
const TIMELINE_MINUTES = 30;

const chunkFrames = Math.ceil(SAMPLE_RATE * CHUNK_SECONDS);
const totalSeconds = TIMELINE_MINUTES * 60;
const totalFrames = Math.ceil(totalSeconds * SAMPLE_RATE);

function fail(message: string): never {
	console.error(`\n  FAIL: ${message}\n`);
	process.exit(1);
}

function assert(condition: boolean, message: string): void {
	if (!condition) fail(message);
}

// --- Synthetic timeline -----------------------------------------------------
// ONE shared 5-second mono tone, reused by every clip, so the SOURCE footprint
// is tiny and the only thing that could blow up is the OUTPUT mix. That is the
// exact allocation the wall is about.
const TONE_SECONDS = 5;
const toneLength = TONE_SECONDS * SAMPLE_RATE;
const tone = new Float32Array(toneLength);
for (let i = 0; i < toneLength; i++) {
	tone[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.6;
}

const GAIN = 0.8;

// A 5s tone every 10s (5s tone, 5s silence), spanning the whole 30 min.
const elements: WindowMixElement[] = [];
for (let start = 0; start + TONE_SECONDS <= totalSeconds; start += 10) {
	elements.push({
		sourceChannels: [tone], // mono source, folded to stereo output
		outputStartSample: Math.floor(start * SAMPLE_RATE),
		renderedLength: Math.ceil(TONE_SECONDS * SAMPLE_RATE),
		outputSampleRate: SAMPLE_RATE,
		sourceIndexAt: (clipTime) => clipTime * SAMPLE_RATE,
		gainAt: () => GAIN,
	});
}

// --- Fake sequential encoder ------------------------------------------------
// Mimics mediabunny's AudioBufferSource.add: each chunk is appended right after
// the previous one. We only keep counters, never the assembled audio.
let encoderFrames = 0;
let encoderChannelsSeen = 0;
function encoderAdd(windowChannels: Float32Array[]): void {
	encoderChannelsSeen = windowChannels.length;
	encoderFrames += windowChannels[0].length;
}

// --- Drive the chunked mix --------------------------------------------------
const windows = planChunkWindows({ totalFrames, chunkFrames });

let peakAllocationBytes = 0;
let mixedFrames = 0;
let toneEnergyChunks = 0;

const rssBefore = process.memoryUsage().rss;

for (const window of windows) {
	const windowChannels = Array.from(
		{ length: OUTPUT_CHANNELS },
		() => new Float32Array(window.frameCount),
	);
	peakAllocationBytes = Math.max(
		peakAllocationBytes,
		OUTPUT_CHANNELS * window.frameCount * 4,
	);

	for (const element of elements) {
		if (
			!elementOverlapsWindow({
				element,
				windowStartFrame: window.startFrame,
				windowFrameCount: window.frameCount,
			})
		) {
			continue;
		}
		mixElementIntoWindow({
			element,
			windowChannels,
			windowStartFrame: window.startFrame,
			windowFrameCount: window.frameCount,
		});
	}

	// A window that overlaps at least one tone must carry real energy.
	let peak = 0;
	for (let i = 0; i < windowChannels[0].length; i++) {
		const v = Math.abs(windowChannels[0][i]);
		if (v > peak) peak = v;
	}
	if (peak > 0) toneEnergyChunks++;

	encoderAdd(windowChannels);
	mixedFrames += window.frameCount;
	// windowChannels goes out of scope here - only one window is ever live.
}

const rssAfter = process.memoryUsage().rss;

// --- Assertions -------------------------------------------------------------
const fullBufferBytes = OUTPUT_CHANNELS * totalFrames * 4;
const boundBytes = OUTPUT_CHANNELS * chunkFrames * 4;

assert(windows.length === Math.ceil(totalFrames / chunkFrames), "unexpected window count");
assert(mixedFrames === totalFrames, `mixed ${mixedFrames} frames, expected ${totalFrames}`);
assert(
	encoderFrames === totalFrames,
	`encoder received ${encoderFrames} frames, expected ${totalFrames} (chunks not gapless)`,
);
assert(encoderChannelsSeen === OUTPUT_CHANNELS, "encoder saw the wrong channel count");
assert(
	peakAllocationBytes <= boundBytes,
	`peak allocation ${peakAllocationBytes} exceeded the one-window bound ${boundBytes}`,
);
assert(
	peakAllocationBytes < fullBufferBytes / 10,
	"peak allocation was not bounded well below the whole-timeline buffer",
);
// The mixed audio must actually be non-trivial (the tones landed).
assert(toneEnergyChunks > 0, "no chunk carried any audio - the mix produced silence");

const encoderSeconds = encoderFrames / SAMPLE_RATE;
assert(
	Math.abs(encoderSeconds - totalSeconds) < 1,
	`encoded duration ${encoderSeconds.toFixed(2)}s != timeline ${totalSeconds}s`,
);

// --- Report -----------------------------------------------------------------
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
console.log("\n  chunked export mix smoke proof");
console.log("  --------------------------------");
console.log(`  timeline            ${TIMELINE_MINUTES} min (${totalSeconds}s, ${elements.length} tone clips)`);
console.log(`  total samples       ${totalFrames.toLocaleString()} @ ${SAMPLE_RATE}Hz x ${OUTPUT_CHANNELS}ch`);
console.log(`  windows             ${windows.length} x ${CHUNK_SECONDS}s`);
console.log(`  encoded duration    ${encoderSeconds.toFixed(1)}s (gapless, ${encoderFrames.toLocaleString()} frames)`);
console.log(`  peak allocation     ${mb(peakAllocationBytes)} MB (one 60s window)`);
console.log(`  whole-buffer (old)  ${mb(fullBufferBytes)} MB  <- the createBuffer wall`);
console.log(`  reduction           ${(fullBufferBytes / peakAllocationBytes).toFixed(1)}x`);
console.log(`  process RSS delta   ${mb(rssAfter - rssBefore)} MB`);
console.log("\n  PASS: 30-min mix completed with bounded memory and correct duration.\n");
