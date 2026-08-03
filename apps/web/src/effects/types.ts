import type { ParamDefinition, ParamValues } from "@/params";

export interface Effect {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

export type EffectUniformValue = number | number[];

export interface EffectPass {
	shader: string;
	uniforms: Record<string, EffectUniformValue>;
}

export interface EffectPassTemplate {
	shader: string;
	uniforms(params: {
		effectParams: ParamValues;
		width: number;
		height: number;
		/**
		 * Seconds elapsed since the clip's own start (its `localTime`), for
		 * effects whose look animates on its own (e.g. noise's per-frame
		 * grain reseed). Defaults to 0 at every call site that has no time
		 * value handy (e.g. a still preview-tile render), which is
		 * indistinguishable from "the first frame" for a time-driven effect.
		 */
		time?: number;
	}): Record<string, EffectUniformValue>;
}

export interface EffectRendererConfig {
	passes: EffectPassTemplate[];
	buildPasses?: (params: {
		effectParams: ParamValues;
		width: number;
		height: number;
		time?: number;
	}) => EffectPass[];
}

export interface EffectDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	/**
	 * Optional param overrides for the catalogue tile thumbnail ONLY. Defaults
	 * are deliberately neutral (a freshly added clip effect must not change the
	 * frame), which would make every tile render the unchanged preview image;
	 * these values are merged over `buildDefaultParamValues(params)` by the
	 * tile render path so the thumbnail shows what the effect does. Never read
	 * when creating a clip effect instance.
	 */
	previewParams?: ParamValues;
	renderer: EffectRendererConfig;
}
