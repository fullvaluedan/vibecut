import { describe, expect, test } from "bun:test";
import { resolveEffectPasses } from "@/effects";
import type { EffectDefinition } from "@/effects/types";

/**
 * T19.4b: `resolveEffectPasses` grew an optional `time` parameter so noise's
 * animated grain can reseed per frame (see noise.ts's long comment for the
 * full finding). This pins down the plumbing itself, independent of any one
 * effect: `time` reaches both the `buildPasses` path and the static
 * `passes[].uniforms()` template path, and defaults to 0 when omitted so
 * every pre-existing call site (and every other effect, which ignores the
 * field entirely) keeps working unchanged.
 */
describe("resolveEffectPasses time threading", () => {
	test("time reaches buildPasses when provided", () => {
		const seen: number[] = [];
		const definition: EffectDefinition = {
			type: "time-probe",
			name: "Time Probe",
			keywords: [],
			params: [],
			renderer: {
				passes: [],
				buildPasses: ({ time }) => {
					seen.push(time ?? -1);
					return [];
				},
			},
		};

		resolveEffectPasses({ definition, effectParams: {}, width: 100, height: 100, time: 4.2 });
		expect(seen).toEqual([4.2]);
	});

	test("time defaults to 0 when the caller omits it", () => {
		const seen: number[] = [];
		const definition: EffectDefinition = {
			type: "time-probe-default",
			name: "Time Probe Default",
			keywords: [],
			params: [],
			renderer: {
				passes: [],
				buildPasses: ({ time }) => {
					seen.push(time ?? -1);
					return [];
				},
			},
		};

		resolveEffectPasses({ definition, effectParams: {}, width: 100, height: 100 });
		expect(seen).toEqual([0]);
	});

	test("time reaches the static passes[].uniforms() template path too", () => {
		const seen: number[] = [];
		const definition: EffectDefinition = {
			type: "time-probe-template",
			name: "Time Probe Template",
			keywords: [],
			params: [],
			renderer: {
				passes: [
					{
						shader: "noop",
						uniforms: ({ time }) => {
							seen.push(time ?? -1);
							return {};
						},
					},
				],
			},
		};

		resolveEffectPasses({ definition, effectParams: {}, width: 100, height: 100, time: 7 });
		expect(seen).toEqual([7]);
	});
});
