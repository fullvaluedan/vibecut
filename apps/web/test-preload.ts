import { mock } from "bun:test";

// The published `opencut-wasm` npm package instantiates its `.wasm` at import
// time via `wasm.__wbindgen_start()`. Under `bun test` on this machine that
// symbol is undefined, so every module that transitively imports `@/wasm`
// (placement, resize, ripple, selection, ...) throws before a single test runs.
// Node loads the same wasm fine; this is a bun/wasm-ESM instantiation gap, not a
// product bug. See docs/TO-VERIFY.md and MEMORY (opencut-wasm is published npm,
// no local Rust toolchain).
//
// The mock below is a faithful pure-JS shim of only the deterministic
// time/tick functions the timeline logic uses. It matches the Rust semantics:
// TICKS_PER_SECOND = 120_000 and frame rounding to the nearest frame boundary
// in integer ticks. GPU/compositor exports are stubbed to no-ops (never called
// from unit tests).

const TICKS_PER_SECOND_VALUE = 120_000;

type FrameRate = { numerator: number; denominator: number };

function ticksPerFrame(rate: FrameRate): number {
	return (TICKS_PER_SECOND_VALUE * rate.denominator) / rate.numerator;
}

function roundToFrame({
	time,
	rate,
}: {
	time: number;
	rate: FrameRate;
}): number {
	const tpf = ticksPerFrame(rate);
	return Math.round(time / tpf) * tpf;
}

function floorToFrame({
	time,
	rate,
}: {
	time: number;
	rate: FrameRate;
}): number {
	const tpf = ticksPerFrame(rate);
	return Math.floor(time / tpf) * tpf;
}

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => TICKS_PER_SECOND_VALUE,
	roundToFrame,
	floorToFrame,
	isFrameAligned: ({ time, rate }: { time: number; rate: FrameRate }) =>
		time % ticksPerFrame(rate) === 0,
	mediaTimeFromFrame: ({ frame, rate }: { frame: number; rate: FrameRate }) =>
		Math.round(frame * ticksPerFrame(rate)),
	mediaTimeToFrame: ({ time, rate }: { time: number; rate: FrameRate }) =>
		BigInt(Math.round(time / ticksPerFrame(rate))),
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * TICKS_PER_SECOND_VALUE),
	mediaTimeToSeconds: ({ time }: { time: number }) =>
		time / TICKS_PER_SECOND_VALUE,
	lastFrameTime: ({
		duration,
		rate,
	}: {
		duration: number;
		rate: FrameRate;
	}) => {
		const tpf = ticksPerFrame(rate);
		return Math.max(0, Math.ceil(duration / tpf) - 1) * tpf;
	},
	snappedSeekTime: ({
		time,
		duration,
		rate,
	}: {
		time: number;
		duration: number;
		rate: FrameRate;
	}) => Math.max(0, Math.min(duration, roundToFrame({ time, rate }))),
	parseTimecode: () => undefined,
	guessTimecodeFormat: () => undefined,
	formatTimecode: () => "",
	// GPU / compositor exports: never reached by unit tests.
	applyEffectPasses: () => undefined,
	applyMaskFeather: () => undefined,
	getCompositorCanvas: () => undefined,
	getLastFrameProfile: () => undefined,
	initCompositor: () => undefined,
	initializeGpu: () => undefined,
	releaseTexture: () => undefined,
	renderFrame: () => undefined,
	resizeCompositor: () => undefined,
	uploadTexture: () => undefined,
}));
