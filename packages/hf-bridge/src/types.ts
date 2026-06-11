/** Variable value types supported by HyperFrames composition variables. */
export type TemplateVariableValue = string | number | boolean;

export interface TemplateVariableDecl {
	id: string;
	type: "string" | "number" | "color" | "boolean" | "enum";
	label: string;
	default: TemplateVariableValue;
	options?: { value: string; label: string }[];
}

export interface HfTemplate {
	id: string;
	name: string;
	/** Shown to the user in the template picker AND to Claude when planning. */
	description: string;
	/** Guidance for the planner: what kind of transcript moment this fits. */
	whenToUse: string;
	variables: TemplateVariableDecl[];
	minDurationSec: number;
	maxDurationSec: number;
	/** Builds a complete standalone HyperFrames index.html for this template. */
	buildCompHtml: (args: {
		width: number;
		height: number;
		durationSec: number;
	}) => string;
}

export interface EffectPlanItem {
	id: string;
	templateId: string;
	/** Timeline-absolute start, seconds. */
	startSec: number;
	durationSec: number;
	variables: Record<string, TemplateVariableValue>;
	/** Planner's one-line reason — shown in UI tooltips. */
	reason: string;
}

export interface EffectPlan {
	items: EffectPlanItem[];
}

export interface TranscriptSegment {
	text: string;
	start: number;
	end: number;
}

export type ClaudeAuth =
	| { mode: "claude-code" }
	| { mode: "api-key"; apiKey: string };

export interface RenderJob {
	templateId: string;
	durationSec: number;
	fps: number;
	width: number;
	height: number;
	variables: Record<string, TemplateVariableValue>;
}

export interface RenderOutcome {
	/** Absolute path to the rendered transparent WebM. */
	videoPath: string;
	/** Absolute path to the persisted comp source dir (never discard — re-renders need it). */
	compDir: string;
}
