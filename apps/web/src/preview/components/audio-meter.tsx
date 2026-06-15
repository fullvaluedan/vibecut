"use client";

import { useEffect, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import type { AudioMeterTap } from "@/core/managers/audio-manager";

/**
 * Observe-only audio peak meter for the preview toolbar.
 *
 * Reads `getFloatTimeDomainData` from the AudioManager's master-bus
 * AnalyserNode(s) on each `requestAnimationFrame` WHILE PLAYING, computes peak
 * and RMS in dBFS per channel, and paints a horizontal green/yellow/red bar
 * with a decaying peak-hold tick and a red clip indicator at 0 dBFS.
 *
 * The rAF loop only runs during playback (it stops on pause) so it costs
 * nothing when the transport is idle. Rendering goes straight to a canvas via
 * refs — no React state churn per frame.
 */

// Meter scale: -60 dBFS (floor) .. 0 dBFS (full scale).
const MIN_DB = -60;
const MAX_DB = 0;
// dBFS at which the bar turns yellow / red.
const YELLOW_DB = -12;
const RED_DB = -3;
// Peak-hold decay rate in dB per second.
const PEAK_DECAY_DB_PER_SEC = 12;
// How long the clip indicator stays lit after the last 0 dBFS sample (ms).
const CLIP_HOLD_MS = 1200;

const CHANNEL_HEIGHT = 4;
const CHANNEL_GAP = 2;

function amplitudeToDb(amplitude: number): number {
	if (amplitude <= 0) return MIN_DB;
	const db = 20 * Math.log10(amplitude);
	return db < MIN_DB ? MIN_DB : db > MAX_DB ? MAX_DB : db;
}

/** Maps a dBFS value to a 0..1 fraction across the meter scale. */
function dbToFraction(db: number): number {
	return (db - MIN_DB) / (MAX_DB - MIN_DB);
}

interface ChannelMeterState {
	/** Smoothed peak-hold value in dBFS (decays over time). */
	peakHoldDb: number;
	/** Timestamp (ms) of last sample at/above 0 dBFS, for clip hold. */
	lastClipAt: number;
}

export function AudioMeter() {
	const editor = useEditor();
	const isPlaying = useEditor((e) => e.playback.getIsPlaying());
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const rafRef = useRef<number | null>(null);
	const channelStatesRef = useRef<ChannelMeterState[]>([]);
	const lastFrameTimeRef = useRef<number>(0);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		// Guard for SSR / browsers without Web Audio: getMeterTap returns null and
		// we simply render an empty (floor) meter without starting the loop.
		if (typeof window === "undefined") return;

		if (!isPlaying) {
			// Paint a single floor frame so the meter shows empty while paused,
			// then stop — no rAF churn while idle.
			drawFloor({ ctx, canvas });
			return;
		}

		const tap: AudioMeterTap | null = editor.audio.ensureMeterTap();
		if (!tap || tap.analysers.length === 0) {
			drawFloor({ ctx, canvas });
			return;
		}

		const analysers = tap.analysers;
		const buffers: Float32Array<ArrayBuffer>[] = analysers.map(
			(analyser) => new Float32Array(analyser.fftSize),
		);

		// (Re)initialise per-channel state to match the live channel count.
		channelStatesRef.current = analysers.map(() => ({
			peakHoldDb: MIN_DB,
			lastClipAt: 0,
		}));
		lastFrameTimeRef.current = performance.now();

		const tick = () => {
			const now = performance.now();
			const dt = Math.max(0, (now - lastFrameTimeRef.current) / 1000);
			lastFrameTimeRef.current = now;

			const states = channelStatesRef.current;
			const peaks: number[] = [];
			const rms: number[] = [];

			for (let ch = 0; ch < analysers.length; ch++) {
				const buffer = buffers[ch];
				// Re-tap safety: an analyser may change fftSize on context rebuild.
				if (buffer.length !== analysers[ch].fftSize) {
					buffers[ch] = new Float32Array(analysers[ch].fftSize);
				}
				analysers[ch].getFloatTimeDomainData(buffers[ch]);

				let peakAmp = 0;
				let sumSquares = 0;
				const samples = buffers[ch];
				for (let i = 0; i < samples.length; i++) {
					const v = Math.abs(samples[i]);
					if (v > peakAmp) peakAmp = v;
					sumSquares += samples[i] * samples[i];
				}
				const rmsAmp = Math.sqrt(sumSquares / samples.length);

				const peakDb = amplitudeToDb(peakAmp);
				const rmsDb = amplitudeToDb(rmsAmp);
				peaks.push(peakDb);
				rms.push(rmsDb);

				const state = states[ch];
				// Peak-hold: jump up instantly, decay over time.
				const decayed = state.peakHoldDb - PEAK_DECAY_DB_PER_SEC * dt;
				state.peakHoldDb = Math.max(peakDb, decayed, MIN_DB);
				// Clip detection: digital full scale (>= ~0 dBFS).
				if (peakAmp >= 0.999) {
					state.lastClipAt = now;
				}
			}

			drawMeter({
				ctx,
				canvas,
				peaks,
				rms,
				states,
				now,
			});

			rafRef.current = requestAnimationFrame(tick);
		};

		rafRef.current = requestAnimationFrame(tick);

		return () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [editor, isPlaying]);

	// Sized for stereo (the master bus is mono/stereo); drawMeter fills the
	// actual live channel count within this canvas.
	const cssHeight = 2 * CHANNEL_HEIGHT + CHANNEL_GAP;

	return (
		<div
			className="flex items-center"
			title="Master output level (dBFS) — observe only"
		>
			<canvas
				ref={canvasRef}
				width={120}
				height={cssHeight}
				style={{ width: 60, height: cssHeight }}
				className="rounded-[2px]"
			/>
		</div>
	);
}

function resolveColors() {
	// Low-alpha neutral track so the empty meter reads as a recessed channel in
	// both light and dark themes; the fill ramp uses fixed meter colours.
	return {
		track: "rgba(127,127,127,0.22)",
		green: "#22c55e",
		yellow: "#eab308",
		red: "#ef4444",
	};
}

function drawFloor({
	ctx,
	canvas,
}: {
	ctx: CanvasRenderingContext2D;
	canvas: HTMLCanvasElement;
}): void {
	const colors = resolveColors();
	const width = canvas.width;
	const height = canvas.height;
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = colors.track;
	ctx.fillRect(0, 0, width, height);
}

function colorForDb({
	db,
	colors,
}: {
	db: number;
	colors: { green: string; yellow: string; red: string };
}): string {
	if (db >= RED_DB) return colors.red;
	if (db >= YELLOW_DB) return colors.yellow;
	return colors.green;
}

function drawMeter({
	ctx,
	canvas,
	peaks,
	rms,
	states,
	now,
}: {
	ctx: CanvasRenderingContext2D;
	canvas: HTMLCanvasElement;
	peaks: number[];
	rms: number[];
	states: ChannelMeterState[];
	now: number;
}): void {
	const colors = resolveColors();
	const width = canvas.width;
	const height = canvas.height;
	const channelCount = peaks.length;
	// Scale the design heights to actual backing-store pixels.
	const rowPx = height / channelCount;
	const gapPx = channelCount > 1 ? 1 : 0;
	const barPx = Math.max(1, rowPx - gapPx);

	ctx.clearRect(0, 0, width, height);

	for (let ch = 0; ch < channelCount; ch++) {
		const top = ch * rowPx;

		// Track background.
		ctx.fillStyle = colors.track;
		ctx.fillRect(0, top, width, barPx);

		// RMS-driven fill, coloured by the peak band so loud transients flash red.
		const fillFraction = dbToFraction(rms[ch]);
		const fillWidth = Math.round(width * fillFraction);
		if (fillWidth > 0) {
			ctx.fillStyle = colorForDb({ db: peaks[ch], colors });
			ctx.fillRect(0, top, fillWidth, barPx);
		}

		// Peak-hold tick.
		const holdFraction = dbToFraction(states[ch].peakHoldDb);
		const holdX = Math.min(width - 2, Math.round(width * holdFraction));
		if (states[ch].peakHoldDb > MIN_DB) {
			ctx.fillStyle = colorForDb({ db: states[ch].peakHoldDb, colors });
			ctx.fillRect(holdX, top, 2, barPx);
		}

		// Clip indicator: a solid red cap at 0 dBFS held briefly after a clip.
		if (now - states[ch].lastClipAt < CLIP_HOLD_MS) {
			ctx.fillStyle = colors.red;
			ctx.fillRect(width - 3, top, 3, barPx);
		}
	}
}
