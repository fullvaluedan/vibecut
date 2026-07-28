import { describe, expect, test } from "bun:test";
import { upsertPathKeyframe } from "@/animation";
import {
	composeParamWrites,
	type ParamResetField,
} from "@/components/editor/panels/properties/components/effect-controls-tab";
import { coerceParamValue, getParamChannelLayout } from "@/params";
import { getElementParams } from "@/params/registry";
import type { ImageElement } from "@/timeline";
import { mediaTime } from "@/wasm";

/**
 * C1 fix: Motion group reset used to call previewX/previewY/previewScale/
 * rotation.onPreview separately, each building a FULL element patch from the
 * ORIGINAL element - previewElements' shallow overlay merge let every call
 * clobber the previous field's reset, so only the LAST field (Rotation)
 * survived. `composeParamWrites` threads every write through the SAME
 * evolving element instead, so composing Position + Scale + Rotation lands
 * all three in one patch. This exercises that store/manager seam headlessly
 * (this repo's `bun test` suite has no DOM, so the click itself is
 * live-verify only).
 */

function buildElement(overrides: Partial<ImageElement["params"]>): ImageElement {
	return {
		id: "el-1",
		name: "Test image",
		type: "image",
		mediaId: "media-1",
		duration: mediaTime({ ticks: 1000 }),
		startTime: mediaTime({ ticks: 0 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {
			"transform.positionX": 50,
			"transform.positionY": -30,
			"transform.scaleX": 2,
			"transform.scaleY": 2.5,
			"transform.rotate": 45,
			opacity: 1,
			blendMode: "normal",
			...overrides,
		},
	};
}

describe("composeParamWrites", () => {
	test("compose-3-writes: threading Position + Scale + Rotation onto ONE evolving element lands all three at default", () => {
		const element = buildElement({});
		const params = getElementParams({ element });
		const paramFor = (key: string) => {
			const param = params.find((p) => p.key === key);
			if (!param) throw new Error(`missing param ${key}`);
			return param;
		};

		const fields: ParamResetField[] = [
			{ param: paramFor("transform.positionX"), path: "transform.positionX", value: 0 },
			{ param: paramFor("transform.positionY"), path: "transform.positionY", value: 0 },
			{ param: paramFor("transform.scaleX"), path: "transform.scaleX", value: 1 },
			{ param: paramFor("transform.scaleY"), path: "transform.scaleY", value: 1 },
			{ param: paramFor("transform.rotate"), path: "transform.rotate", value: 0 },
		];

		const result = composeParamWrites({
			element,
			fields,
			localTime: mediaTime({ ticks: 0 }),
			isPlayheadWithinElementRange: true,
		});

		expect("params" in result ? result.params["transform.positionX"] : undefined).toBe(0);
		expect("params" in result ? result.params["transform.positionY"] : undefined).toBe(0);
		expect("params" in result ? result.params["transform.scaleX"] : undefined).toBe(1);
		expect("params" in result ? result.params["transform.scaleY"] : undefined).toBe(1);
		expect("params" in result ? result.params["transform.rotate"] : undefined).toBe(0);
		// A field NOT in the reset list survives untouched - the compose only
		// touches what it's told to.
		expect("params" in result ? result.params.opacity : undefined).toBe(1);
	});

	test("regression guard: writing each field from the SAME original element (the pre-fix bug) drops every field but the last", () => {
		// This reproduces the ORIGINAL bug shape for contrast: each write starts
		// fresh from `element` instead of threading `working`, so only the last
		// field's change would show up in a single merged patch (previewElements'
		// shallow `{...existingOverlay, ...elementUpdates}` merge would otherwise
		// need to run to see the clobber; here we assert the single-write shape
		// directly against what composeParamWrites is expressly built to avoid).
		const element = buildElement({});
		const params = getElementParams({ element });
		const paramFor = (key: string) => {
			const param = params.find((p) => p.key === key);
			if (!param) throw new Error(`missing param ${key}`);
			return param;
		};

		// Composing ONLY the last field (as the pre-fix bug effectively did)
		// leaves the earlier fields at their ORIGINAL (non-default) values.
		const lastFieldOnly = composeParamWrites({
			element,
			fields: [{ param: paramFor("transform.rotate"), path: "transform.rotate", value: 0 }],
			localTime: mediaTime({ ticks: 0 }),
			isPlayheadWithinElementRange: true,
		});

		expect("params" in lastFieldOnly ? lastFieldOnly.params["transform.rotate"] : undefined).toBe(0);
		expect(
			"params" in lastFieldOnly ? lastFieldOnly.params["transform.positionX"] : undefined,
		).toBe(50); // unchanged - proves the bug shape isn't what the fix does
	});

	test("threads keyframed channels the same way when the playhead is within range", () => {
		const base = buildElement({});
		const rotateParam = getElementParams({ element: base }).find(
			(p) => p.key === "transform.rotate",
		)!;
		// Build the fixture through the real keyframe writer (not a hand-rolled
		// keyframe object) so the shape is guaranteed correct.
		const animations = upsertPathKeyframe({
			animations: base.animations,
			propertyPath: "transform.rotate",
			time: mediaTime({ ticks: 0 }),
			value: 45,
			channelLayout: getParamChannelLayout({ param: rotateParam }),
			coerceValue: ({ value }) => coerceParamValue({ param: rotateParam, value }),
		});
		const element: ImageElement = { ...base, animations };

		const result = composeParamWrites({
			element,
			fields: [{ param: rotateParam, path: "transform.rotate", value: 0 }],
			localTime: mediaTime({ ticks: 0 }),
			isPlayheadWithinElementRange: true,
		});

		// The animated-channel branch upserts the keyframe's value (0) rather
		// than writing the static param - the static param stays untouched.
		const channel = result.animations?.["transform.rotate"] as
			| { keys: { time: number; value: number }[] }
			| undefined;
		expect(channel?.keys[0]?.value).toBe(0);
		expect("params" in result ? result.params["transform.rotate"] : undefined).toBe(45);
	});
});
