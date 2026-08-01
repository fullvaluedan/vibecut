export const DEFAULT_RETIME_RATE = 1;
export const MIN_RETIME_RATE = 0.01;
export const MAX_RETIME_RATE = 5;

export function clampRetimeRate({ rate }: { rate: number }): number {
	if (!Number.isFinite(rate) || rate <= 0) {
		return DEFAULT_RETIME_RATE;
	}

	return Math.min(Math.max(rate, MIN_RETIME_RATE), MAX_RETIME_RATE);
}

export function canMaintainPitch({ rate }: { rate: number }): boolean {
	return Number.isFinite(rate) && rate > 0;
}

export function shouldMaintainPitch({
	rate,
	maintainPitch,
}: {
	rate: number;
	maintainPitch?: boolean;
}): boolean {
	return maintainPitch === true && canMaintainPitch({ rate });
}

/**
 * T18.2 audio-under-curve decision: the pitch-preserving stretch path
 * (audio-stretch.ts's `buildPitchPreservedBuffer`) drives a single
 * soundtouchjs `PitchShifter` at one constant `tempo` - it has no notion of
 * a rate that varies over the clip, so it can't represent a curve. Rather
 * than build a variable-rate pitch-preserving stretcher (a much larger DSP
 * undertaking), v1 ships: a curve-active clip's audio always RESAMPLES along
 * the curve's exact source-time path - frame-accurate, the same
 * `getSourceTimeAtClipTime` the renderer's video sampling uses, in both live
 * preview (audio-manager.ts's prepared-buffer path, see `hasCurveRetime`)
 * and export (media/audio.ts) - with pitch shifting NATURALLY, i.e.
 * `maintainPitch` is ignored while a curve is active. Audio always plays,
 * always in sync with the curve; it just isn't pitch-corrected. See
 * speed-tab.tsx for the matching UI (the "Change pitch" toggle is disabled
 * while a curve is active).
 */
export function shouldUsePitchPreservedRetimeBuffer({
	rate,
	maintainPitch,
	hasCurve,
}: {
	rate: number;
	maintainPitch?: boolean;
	hasCurve: boolean;
}): boolean {
	return !hasCurve && shouldMaintainPitch({ rate, maintainPitch });
}

/**
 * T18.1: rate stays at 1x while reversed (see RetimeConfig.reversed doc
 * comment in timeline/types.ts) - the Speed tab disables the rate field
 * when reversed is on, and this is the single place that enforces it for
 * any programmatic caller (assistant ops, presets) too.
 */
export function isRetimeReversed({
	retime,
}: {
	retime?: { reversed?: boolean };
}): boolean {
	return retime?.reversed === true;
}

export function clampRetimeForReverse({
	rate,
	reversed,
}: {
	rate: number;
	reversed: boolean;
}): number {
	return reversed ? DEFAULT_RETIME_RATE : rate;
}
