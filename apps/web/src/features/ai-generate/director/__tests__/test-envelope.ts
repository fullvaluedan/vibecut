import { ENERGY_WINDOW_SEC } from "../audio-features";

/**
 * Envelope of `seconds` at `base` RMS level with [start, end, level]
 * overrides painted on top, hopped at the shared Director envelope window
 * (ENERGY_WINDOW_SEC). Shared fixture builder for the hallucination-guard,
 * envelope-dead-air, and swallow-pause suites, which each built this
 * independently before it was extracted here.
 */
export function envelope(
	seconds: number,
	base: number,
	...spans: [number, number, number][]
): number[] {
	const env = new Array<number>(Math.round(seconds / ENERGY_WINDOW_SEC)).fill(base);
	for (const [s, e, level] of spans) {
		for (
			let w = Math.floor(s / ENERGY_WINDOW_SEC);
			w < Math.min(env.length, Math.ceil(e / ENERGY_WINDOW_SEC));
			w++
		) {
			env[w] = level;
		}
	}
	return env;
}
