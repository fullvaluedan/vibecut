/**
 * T18.3: pure math for per-clip audio fade in/out (CapCut-style corner
 * handles + numeric fields). No browser or `@/wasm` imports, so this runs
 * under plain `bun test` and is trivially unit-testable.
 *
 * Curve shape: a quarter-arc (quarter-sine) envelope, `gain = sin(progress *
 * pi/2)`. This is the standard equal-power fade arc (concave: rises fast
 * then eases into 1.0, and symmetrically for the tail) - chosen once here so
 * the timeline curve overlay, live preview playback, and export mixdown all
 * read the exact same function and can never disagree.
 */

import { clamp } from "@/utils/math";

export interface FadePair {
	fadeInSec: number;
	fadeOutSec: number;
}

/**
 * Resolves one requested fade against the other, so the two never cross:
 * the field named by `priority` is clamped to `[0, durationSec]` first (it
 * "wins," matching a user actively dragging or typing that field), then the
 * other field is clamped to whatever room is left. Used both for live edits
 * (drag handles, numeric fields) and for read-time clamping after a trim
 * shrinks the clip (see `clampFadesToDuration`).
 */
export function resolveFadePair({
	fadeInSec,
	fadeOutSec,
	durationSec,
	priority,
}: {
	fadeInSec: number;
	fadeOutSec: number;
	durationSec: number;
	priority: "fadeIn" | "fadeOut";
}): FadePair {
	const safeDuration = Math.max(0, durationSec);
	const safeFadeIn = Number.isFinite(fadeInSec) ? Math.max(0, fadeInSec) : 0;
	const safeFadeOut = Number.isFinite(fadeOutSec) ? Math.max(0, fadeOutSec) : 0;

	if (priority === "fadeIn") {
		const nextFadeInSec = clamp({ value: safeFadeIn, min: 0, max: safeDuration });
		const nextFadeOutSec = clamp({
			value: safeFadeOut,
			min: 0,
			max: Math.max(0, safeDuration - nextFadeInSec),
		});
		return { fadeInSec: nextFadeInSec, fadeOutSec: nextFadeOutSec };
	}

	const nextFadeOutSec = clamp({ value: safeFadeOut, min: 0, max: safeDuration });
	const nextFadeInSec = clamp({
		value: safeFadeIn,
		min: 0,
		max: Math.max(0, safeDuration - nextFadeOutSec),
	});
	return { fadeInSec: nextFadeInSec, fadeOutSec: nextFadeOutSec };
}

/**
 * Read-time clamp used when neither field is being actively edited (e.g.
 * after a trim shrinks the clip's duration): fade in keeps priority over
 * fade out. Trimming a clip shorter than its stored fades therefore always
 * yields an effective pair that fits inside the new duration, without
 * mutating the stored (untrimmed) values - if the clip is extended again,
 * the original fades come back.
 */
export function clampFadesToDuration({
	fadeInSec,
	fadeOutSec,
	durationSec,
}: {
	fadeInSec: number;
	fadeOutSec: number;
	durationSec: number;
}): FadePair {
	return resolveFadePair({ fadeInSec, fadeOutSec, durationSec, priority: "fadeIn" });
}

/**
 * Quarter-arc gain at `localTimeSec` inside a clip of `durationSec`, given
 * (unclamped) requested `fadeInSec`/`fadeOutSec`. Returns a multiplier in
 * [0, 1]: 1.0 outside both fade windows, ramping via `sin(progress * pi/2)`
 * inside them. This is the ONE place the fade curve is computed - the
 * timeline curve overlay samples it directly, and the render/playback gain
 * path multiplies it into the resolved volume (see `audio-state.ts`
 * `resolveEffectiveAudioGain`), so preview and export always agree.
 */
export function computeFadeGain({
	localTimeSec,
	durationSec,
	fadeInSec,
	fadeOutSec,
}: {
	localTimeSec: number;
	durationSec: number;
	fadeInSec: number;
	fadeOutSec: number;
}): number {
	if (!(durationSec > 0)) {
		return 1;
	}

	const { fadeInSec: clampedIn, fadeOutSec: clampedOut } = clampFadesToDuration({
		fadeInSec,
		fadeOutSec,
		durationSec,
	});
	const t = clamp({ value: localTimeSec, min: 0, max: durationSec });

	let gain = 1;

	if (clampedIn > 0 && t < clampedIn) {
		const progress = clamp({ value: t / clampedIn, min: 0, max: 1 });
		gain = Math.min(gain, Math.sin(progress * (Math.PI / 2)));
	}

	if (clampedOut > 0) {
		const timeFromEnd = durationSec - t;
		if (timeFromEnd < clampedOut) {
			const progress = clamp({ value: timeFromEnd / clampedOut, min: 0, max: 1 });
			gain = Math.min(gain, Math.sin(progress * (Math.PI / 2)));
		}
	}

	return gain;
}
