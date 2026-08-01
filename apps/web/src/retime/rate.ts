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
