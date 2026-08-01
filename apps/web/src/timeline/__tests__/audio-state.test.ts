import { describe, expect, test } from "bun:test";
import type { AudioElement, VideoElement } from "@/timeline";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import type { ParamValues } from "@/params";
import {
	dBToLinear,
	getElementFadeInSec,
	getElementFadeOutSec,
	hasAudioFade,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

function secondsToTicks({ seconds }: { seconds: number }) {
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

function makeAudioElement({
	durationSec,
	params = {},
	animations,
}: {
	durationSec: number;
	params?: ParamValues;
	animations?: ElementAnimations;
}): AudioElement {
	return {
		id: "audio-1",
		name: "Audio",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		duration: secondsToTicks({ seconds: durationSec }),
		startTime: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params,
		animations,
	};
}

function makeVideoElement({
	durationSec,
	params = {},
}: {
	durationSec: number;
	params?: ParamValues;
}): VideoElement {
	return {
		id: "video-1",
		name: "Video",
		type: "video",
		mediaId: "media-1",
		duration: secondsToTicks({ seconds: durationSec }),
		startTime: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params,
	};
}

/** Single held keyframe: constant `value` across the whole clip (see interpolation.ts hold-extrapolation for a lone key). */
function holdVolumeKeyframe({ value }: { value: number }): ElementAnimations {
	const key: ScalarAnimationKey = {
		id: "kf-1",
		time: ZERO_MEDIA_TIME,
		value,
		segmentToNext: "linear",
		tangentMode: "auto",
	};
	return { volume: { keys: [key] } };
}

describe("resolveEffectiveAudioGain - fade composition (T18.3)", () => {
	test("no fade, no keyframes: matches plain dB-to-linear volume", () => {
		const element = makeAudioElement({ durationSec: 10, params: { volume: -6 } });
		const gain = resolveEffectiveAudioGain({ element, localTime: 5 });
		expect(gain).toBeCloseTo(dBToLinear(-6), 5);
	});

	test("fade-in at t=0 mutes even a loud static volume (multiplies, does not overwrite)", () => {
		const element = makeAudioElement({
			durationSec: 10,
			params: { volume: 10, fadeInSec: 2 },
		});
		const gain = resolveEffectiveAudioGain({ element, localTime: 0 });
		expect(gain).toBeCloseTo(0, 5);
	});

	test("gain at t=fadeIn equals the plain dB-to-linear volume (fade fully open)", () => {
		const element = makeAudioElement({
			durationSec: 10,
			params: { volume: 3, fadeInSec: 2 },
		});
		const gain = resolveEffectiveAudioGain({ element, localTime: 2 });
		expect(gain).toBeCloseTo(dBToLinear(3), 5);
	});

	test("composes with a volume keyframe: product of keyframed dB and fade gain is used", () => {
		const element = makeAudioElement({
			durationSec: 10,
			params: { volume: 0, fadeInSec: 4 },
			animations: holdVolumeKeyframe({ value: -20 }),
		});
		// Halfway through a 4s fade-in: gain = sin(0.5 * pi/2) = sqrt(2)/2.
		const gain = resolveEffectiveAudioGain({ element, localTime: 2 });
		const expectedFadeGain = Math.SQRT1_2;
		expect(gain).toBeCloseTo(dBToLinear(-20) * expectedFadeGain, 5);
	});

	test("muted element is silent regardless of fade", () => {
		const element = makeAudioElement({
			durationSec: 10,
			params: { volume: 0, muted: true, fadeInSec: 0, fadeOutSec: 0 },
		});
		expect(resolveEffectiveAudioGain({ element, localTime: 5 })).toBe(0);
	});

	test("works the same way for a video element's embedded audio", () => {
		const element = makeVideoElement({
			durationSec: 6,
			params: { volume: 0, fadeOutSec: 2 },
		});
		// t=duration: fully faded out.
		expect(resolveEffectiveAudioGain({ element, localTime: 6 })).toBeCloseTo(0, 5);
		// t=0: fade-out hasn't started, fully open.
		expect(resolveEffectiveAudioGain({ element, localTime: 0 })).toBeCloseTo(1, 5);
	});
});

describe("getElementFadeInSec / getElementFadeOutSec - trim clamping", () => {
	test("absent params default to 0 (serialization backward-compat)", () => {
		const element = makeAudioElement({ durationSec: 10 });
		expect(getElementFadeInSec({ element })).toBe(0);
		expect(getElementFadeOutSec({ element })).toBe(0);
		expect(hasAudioFade({ element })).toBe(false);
	});

	test("values that fit the clip pass through unchanged", () => {
		const element = makeAudioElement({
			durationSec: 10,
			params: { fadeInSec: 2, fadeOutSec: 3 },
		});
		expect(getElementFadeInSec({ element })).toBe(2);
		expect(getElementFadeOutSec({ element })).toBe(3);
		expect(hasAudioFade({ element })).toBe(true);
	});

	test("trimming the clip shorter than the stored fades clamps the effective read", () => {
		// Fades were set while the clip was 10s long; the clip is now 3s (trimmed).
		const element = makeAudioElement({
			durationSec: 3,
			params: { fadeInSec: 4, fadeOutSec: 4 },
		});
		const fadeIn = getElementFadeInSec({ element });
		const fadeOut = getElementFadeOutSec({ element });
		expect(fadeIn + fadeOut).toBeLessThanOrEqual(3);
		expect(fadeIn).toBe(3);
		expect(fadeOut).toBe(0);
	});
});
