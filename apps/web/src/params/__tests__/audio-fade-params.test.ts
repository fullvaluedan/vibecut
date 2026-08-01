import { describe, expect, test } from "bun:test";
import {
	getBuiltInElementParams,
	getElementParam,
	readElementParamValue,
	writeElementParamValue,
} from "@/params/registry";
import type { AudioElement, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * T18.3: fadeInSec/fadeOutSec are registered like volume/muted (default 0,
 * absent from an old project's `params` falls through to the default), and
 * their `write` callbacks clamp against the clip's own duration so the two
 * fades never cross - the same rule the drag handles enforce.
 */

function secondsToTicks({ seconds }: { seconds: number }) {
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

function findParam({ type, key }: { type: "audio" | "video"; key: string }) {
	return getBuiltInElementParams({ type }).find((p) => p.key === key);
}

function buildAudioElement({
	durationSec,
	fadeInSec,
	fadeOutSec,
}: {
	durationSec: number;
	fadeInSec?: number;
	fadeOutSec?: number;
}): AudioElement {
	return {
		id: "a1",
		name: "a1",
		type: "audio",
		sourceType: "upload",
		mediaId: "m1",
		duration: secondsToTicks({ seconds: durationSec }),
		startTime: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			volume: 0,
			muted: false,
			...(fadeInSec !== undefined ? { fadeInSec } : {}),
			...(fadeOutSec !== undefined ? { fadeOutSec } : {}),
		},
	};
}

function buildVideoElement({
	durationSec,
	fadeInSec,
	fadeOutSec,
}: {
	durationSec: number;
	fadeInSec?: number;
	fadeOutSec?: number;
}): VideoElement {
	return {
		id: "v1",
		name: "v1",
		type: "video",
		mediaId: "m1",
		duration: secondsToTicks({ seconds: durationSec }),
		startTime: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			volume: 0,
			muted: false,
			...(fadeInSec !== undefined ? { fadeInSec } : {}),
			...(fadeOutSec !== undefined ? { fadeOutSec } : {}),
		},
	};
}

describe("fadeInSec / fadeOutSec param definitions", () => {
	test("registered on both audio and video element types", () => {
		expect(findParam({ type: "audio", key: "fadeInSec" })).toBeDefined();
		expect(findParam({ type: "audio", key: "fadeOutSec" })).toBeDefined();
		expect(findParam({ type: "video", key: "fadeInSec" })).toBeDefined();
		expect(findParam({ type: "video", key: "fadeOutSec" })).toBeDefined();
	});

	test("default to 0 (inert) and are not keyframable", () => {
		const fadeIn = findParam({ type: "audio", key: "fadeInSec" });
		const fadeOut = findParam({ type: "audio", key: "fadeOutSec" });
		expect(fadeIn?.default).toBe(0);
		expect(fadeOut?.default).toBe(0);
		expect(fadeIn?.keyframable).toBe(false);
		expect(fadeOut?.keyframable).toBe(false);
	});

	test("an element with no fadeInSec/fadeOutSec in params reads back the default (serialization backward-compat)", () => {
		const element = buildAudioElement({ durationSec: 10 });
		const fadeInParam = getElementParam({ element, key: "fadeInSec" });
		const fadeOutParam = getElementParam({ element, key: "fadeOutSec" });
		expect(fadeInParam).not.toBeNull();
		expect(fadeOutParam).not.toBeNull();
		if (!fadeInParam || !fadeOutParam) return;
		expect(readElementParamValue({ element, param: fadeInParam })).toBe(0);
		expect(readElementParamValue({ element, param: fadeOutParam })).toBe(0);
	});
});

describe("fadeInSec / fadeOutSec write clamping", () => {
	test("writing fadeInSec beyond the clip shrinks the stored fadeOutSec to fit", () => {
		const element = buildAudioElement({ durationSec: 5, fadeOutSec: 2 });
		const param = getElementParam({ element, key: "fadeInSec" });
		expect(param).not.toBeNull();
		if (!param) return;

		// Request a fade-in far longer than the 5s clip.
		const updated = writeElementParamValue({
			element,
			param,
			value: 999,
		}) as AudioElement;
		expect(updated.params.fadeInSec).toBe(5);
		expect(updated.params.fadeOutSec).toBe(0);
	});

	test("writing fadeOutSec beyond the clip shrinks the stored fadeInSec to fit (video element)", () => {
		const element = buildVideoElement({ durationSec: 2, fadeInSec: 1.5 });
		const param = getElementParam({ element, key: "fadeOutSec" });
		expect(param).not.toBeNull();
		if (!param) return;

		const updated = writeElementParamValue({
			element,
			param,
			value: 10,
		}) as VideoElement;
		// Duration is 2s; requesting a 10s fade-out clamps to 2s, and the
		// pre-existing 1.5s fade-in is squeezed to whatever is left (0s here).
		expect(updated.params.fadeOutSec).toBe(2);
		expect(updated.params.fadeInSec).toBe(0);
	});

	test("values that fit are written through unchanged", () => {
		const element = buildAudioElement({ durationSec: 10, fadeOutSec: 1 });
		const param = getElementParam({ element, key: "fadeInSec" });
		expect(param).not.toBeNull();
		if (!param) return;

		const updated = writeElementParamValue({
			element,
			param,
			value: 2,
		}) as AudioElement;
		expect(updated.params.fadeInSec).toBe(2);
		expect(updated.params.fadeOutSec).toBe(1);
	});
});
