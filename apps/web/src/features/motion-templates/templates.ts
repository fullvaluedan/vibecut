/**
 * Native motion templates: the five HyperFrames planner templates rebuilt as
 * ordinary text/graphic elements with pre-baked keyframes. They insert
 * instantly, play in the native preview AND export (no Chrome render, no
 * ffmpeg burn-in), and stay fully editable afterwards.
 *
 * Variable ids intentionally MATCH packages/hf-bridge templates so the AI
 * planner's items drive either engine unchanged:
 *   callout-pill {text, accent, corner} Â· kinetic-title {text, accent}
 *   lower-third {title, subtitle, accent, align} Â· number-pop {value, label, accent}
 *   section-break {text, kicker, accent}
 */

import type { ElementAnimations } from "@/animation/types";
import type {
	CreateTimelineElement,
	SceneTracks,
	TextElement,
} from "@/timeline";
import { buildTextElement } from "@/timeline/element-utils";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";
import {
	bakeAnimations,
	fadeSlide,
	popIn,
	resolveEnterExit,
	type TemplateChannels,
} from "./keyframes";

export type TemplateVariables = Record<string, string | number | boolean>;

export interface MotionTemplateArgs {
	startTime: MediaTime;
	durationSec: number;
	variables: TemplateVariables;
	accent: string;
	canvasSize: { width: number; height: number };
	/** Shared across the elements one apply produces. */
	groupId?: string;
	/** Prefix names with "AI: " when placed by the planner. */
	fromAi?: boolean;
	/** User size multiplier on top of canvas-proportional sizing (default 1). */
	scale?: number;
	/** The active look's typeface, applied to all of this template's text. */
	fontFamily?: string;
}

/** One editable field surfaced in the Template Controls panel. */
export interface TemplateField {
	key: string;
	label: string;
	type: "text" | "color" | "enum";
	options?: { value: string; label: string }[];
	/** Seed shown when the element has no value yet (color fields fall back
	 *  to the active style accent when omitted). */
	default?: string;
}

export interface MotionTemplate {
	id: string;
	name: string;
	description: string;
	defaultDurationSec: number;
	durationRange: { min: number; max: number };
	/** Editable variables shown in the Template Controls panel. */
	fields: TemplateField[];
	build: (args: MotionTemplateArgs) => CreateTimelineElement[];
	/** Hidden from the insert gallery (used internally, e.g. by the Swiss grid). */
	internal?: boolean;
	/**
	 * The built elements are distinct BEATS the user times independently (each
	 * gets its own startTime, no shared linkId). Template Controls restyles them
	 * as a group but preserves each beat's own start/duration on rebuild.
	 */
	multiPoint?: boolean;
}

const DARK_PILL = "#0b0d12";

const CORNER_OPTIONS = [
	{ value: "top-left", label: "Top left" },
	{ value: "top-right", label: "Top right" },
	{ value: "bottom-left", label: "Bottom left" },
	{ value: "bottom-right", label: "Bottom right" },
];
const ALIGN_OPTIONS = [
	{ value: "left", label: "Left" },
	{ value: "right", label: "Right" },
];

function str(variables: TemplateVariables, key: string, fallback: string): string {
	const value = variables[key];
	return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * Scale factor for canvas-proportional sizing: every px value in template
 * builders is authored against a 1080p frame and multiplied by this, so a
 * 720p or 4K project gets the same visual proportions.
 */
function canvasScale(
	canvasSize: { width: number; height: number },
	scale = 1,
): number {
	return (canvasSize.height / 1080) * scale;
}

/**
 * Multiplier for fontSize ONLY. The text renderer already scales fontSize by
 * canvasHeight/90 (so fontSize is a resolution-relative unit where ~15 is a
 * normal size — see text/typography.ts), which makes text canvas-proportional
 * on its own. So fontSize must NOT carry the height/1080 term that positions
 * do (carrying it double-scales text — quadratically on non-1080 canvases).
 * It only carries the user's size multiplier.
 */
function fontScale(scale = 1): number {
	return scale;
}

function buildTemplateText({
	args,
	templateId,
	label,
	durationSec,
	params,
	channels,
	hidden,
	linkPieces = true,
}: {
	args: MotionTemplateArgs;
	templateId: string;
	label: string;
	durationSec: number;
	params: Record<string, string | number | boolean>;
	channels: TemplateChannels;
	/** Stable-count templates create some elements hidden until used. */
	hidden?: boolean;
	/**
	 * MOGRT behavior (default): the pieces share a linkId so linked selection
	 * moves/trims them as one clip. Set false for multi-beat templates whose
	 * pieces should be timed independently (they still share groupId for style).
	 */
	linkPieces?: boolean;
}): CreateTimelineElement {
	const groupId = args.groupId ?? generateUUID();
	const base = buildTextElement({
		raw: {
			name: `${args.fromAi ? "AI: " : ""}${label}`,
			duration: mediaTimeFromSeconds({ seconds: durationSec }),
			...(hidden ? { hidden: true } : {}),
			// The look's font applies to every template's text; a template can
			// still override fontFamily in its own params (none do today).
			params: args.fontFamily
				? { fontFamily: args.fontFamily, ...params }
				: params,
			motionTemplate: {
				templateId,
				groupId,
				variables: args.variables,
				...(args.scale !== undefined && args.scale !== 1
					? { scale: args.scale }
					: {}),
			},
			...(linkPieces ? { linkId: groupId } : {}),
		},
		startTime: args.startTime,
	});
	const animations = bakeAnimations({ element: base, channels });
	return animations ? { ...base, animations } : base;
}

/**
 * Re-bakes a template element's animations for a NEW duration (entrances
 * pinned to the start, exits pinned to the new end). Rebuilds the spec and
 * returns the matching element's freshly baked animations.
 */
export function rebakeTemplateAnimations({
	templateId,
	durationSec,
	variables,
	accent,
	canvasSize,
	elementIndex,
}: {
	templateId: string;
	durationSec: number;
	variables: TemplateVariables;
	accent: string;
	canvasSize: { width: number; height: number };
	elementIndex: number;
}): ElementAnimations | undefined {
	const template = getMotionTemplate(templateId);
	if (!template) return undefined;
	const specs = template.build({
		startTime: ZERO_MEDIA_TIME,
		durationSec,
		variables,
		accent,
		canvasSize,
	});
	const spec = specs[Math.min(elementIndex, specs.length - 1)];
	return spec?.animations;
}

export const MOTION_TEMPLATES: MotionTemplate[] = [
	{
		id: "callout-pill",
		name: "Callout pill",
		description: "Short phrase in a corner pill",
		defaultDurationSec: 3,
		durationRange: { min: 1, max: 10 },
		fields: [
			{ key: "text", label: "Text", type: "text", default: "Callout" },
			{
				key: "corner",
				label: "Corner",
				type: "enum",
				options: CORNER_OPTIONS,
				default: "top-right",
			},
			{ key: "accent", label: "Text color", type: "color" },
		],
		build: (args) => {
			const { width, height } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const corner = String(args.variables.corner ?? "top-right");
			const x = corner.includes("left")
				? -(width / 2 - 320 * k)
				: width / 2 - 320 * k;
			const y = corner.includes("bottom")
				? height / 2 - 130 * k
				: -(height / 2 - 130 * k);
			const channels = fadeSlide({
				durationSec: args.durationSec,
				baseX: x,
				baseY: y,
				fromDy: (corner.includes("bottom") ? 40 : -40) * k,
			});
			const element = buildTemplateText({
				args,
				templateId: "callout-pill",
				label: "Callout pill",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "text", "Callout"),
					fontSize: Math.round(6 * fontScale(args.scale)),
					fontWeight: "bold",
					color: str(args.variables, "accent", args.accent),
					textAlign: "center",
					"transform.positionX": x,
					"transform.positionY": y,
					"background.enabled": true,
					"background.color": DARK_PILL,
					"background.cornerRadius": 50,
					"background.paddingX": Math.round(28 * k),
					"background.paddingY": Math.round(14 * k),
				},
				channels,
			});
			return [element];
		},
	},
	{
		id: "kinetic-title",
		name: "Kinetic title",
		description: "Big pop-in title",
		defaultDurationSec: 3.5,
		durationRange: { min: 1, max: 10 },
		fields: [
			{ key: "text", label: "Title", type: "text", default: "TITLE" },
			{ key: "color", label: "Text color", type: "color", default: "#ffffff" },
		],
		build: (args) => {
			const k = canvasScale(args.canvasSize, args.scale);
			const channels = popIn({ durationSec: args.durationSec });
			const element = buildTemplateText({
				args,
				templateId: "kinetic-title",
				label: "Kinetic title",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "text", "TITLE").toUpperCase(),
					fontSize: Math.round(25 * fontScale(args.scale)),
					fontWeight: "bold",
					color: str(args.variables, "color", "#ffffff"),
					textAlign: "center",
					letterSpacing: 2,
				},
				channels,
			});
			return [element];
		},
	},
	{
		id: "lower-third",
		name: "Lower third",
		description: "Name + subtitle bars",
		defaultDurationSec: 4,
		durationRange: { min: 1.5, max: 12 },
		fields: [
			{ key: "title", label: "Name", type: "text", default: "Name" },
			{ key: "subtitle", label: "Subtitle", type: "text", default: "Subtitle" },
			{
				key: "align",
				label: "Side",
				type: "enum",
				options: ALIGN_OPTIONS,
				default: "left",
			},
			{ key: "accent", label: "Bar color", type: "color" },
		],
		build: (args) => {
			const { width, height } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const align = String(args.variables.align ?? "left");
			const sign = align === "right" ? 1 : -1;
			const x = sign * (width / 2 - 380 * k);
			const titleY = height / 2 - 190 * k;
			const subY = height / 2 - 120 * k;
			const slide = sign * -60 * k;
			const groupId = args.groupId ?? generateUUID();
			const shared = { ...args, groupId };
			const titleChannels = fadeSlide({
				durationSec: args.durationSec,
				baseX: x,
				baseY: titleY,
				fromDx: slide,
			});
			const subChannels = fadeSlide({
				durationSec: args.durationSec,
				baseX: x,
				baseY: subY,
				fromDx: slide,
				delaySec: 0.12,
			});
			const title = buildTemplateText({
				args: shared,
				templateId: "lower-third",
				label: "Lower third",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "title", "Name"),
					fontSize: Math.round(8 * fontScale(args.scale)),
					fontWeight: "bold",
					color: "#0b0d12",
					textAlign: align === "right" ? "right" : "left",
					"transform.positionX": x,
					"transform.positionY": titleY,
					"background.enabled": true,
					"background.color": str(args.variables, "accent", args.accent),
					"background.cornerRadius": 8,
					"background.paddingX": Math.round(22 * k),
					"background.paddingY": Math.round(10 * k),
				},
				channels: titleChannels,
			});
			const subtitle = buildTemplateText({
				args: shared,
				templateId: "lower-third",
				label: "Lower third subtitle",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "subtitle", "Subtitle"),
					fontSize: Math.round(5 * fontScale(args.scale)),
					color: "#ffffff",
					textAlign: align === "right" ? "right" : "left",
					"transform.positionX": x,
					"transform.positionY": subY,
					"background.enabled": true,
					"background.color": DARK_PILL,
					"background.cornerRadius": 8,
					"background.paddingX": Math.round(18 * k),
					"background.paddingY": Math.round(8 * k),
				},
				channels: subChannels,
			});
			return [title, subtitle];
		},
	},
	{
		id: "number-pop",
		name: "Number pop",
		description: "Huge stat + label",
		defaultDurationSec: 3,
		durationRange: { min: 1, max: 10 },
		fields: [
			{ key: "value", label: "Number", type: "text", default: "100%" },
			{ key: "label", label: "Label", type: "text", default: "Label" },
			{ key: "accent", label: "Number color", type: "color" },
		],
		build: (args) => {
			const k = canvasScale(args.canvasSize, args.scale);
			const groupId = args.groupId ?? generateUUID();
			const shared = { ...args, groupId };
			const valueChannels = popIn({ durationSec: args.durationSec });
			const labelChannels = fadeSlide({
				durationSec: args.durationSec,
				baseX: 0,
				baseY: 110 * k,
				fromDy: 30 * k,
				delaySec: 0.15,
			});
			const value = buildTemplateText({
				args: shared,
				templateId: "number-pop",
				label: "Number pop",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "value", "100%"),
					fontSize: Math.round(23 * fontScale(args.scale)),
					fontWeight: "bold",
					color: str(args.variables, "accent", args.accent),
					textAlign: "center",
					"transform.positionY": -30 * k,
				},
				channels: valueChannels,
			});
			const label = buildTemplateText({
				args: shared,
				templateId: "number-pop",
				label: "Number pop label",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "label", "Label"),
					fontSize: Math.round(5 * fontScale(args.scale)),
					color: "#ffffff",
					textAlign: "center",
					"transform.positionY": 110 * k,
				},
				channels: labelChannels,
			});
			return [value, label];
		},
	},
	{
		id: "section-break",
		name: "Section break",
		description: "Accent bar chapter card",
		defaultDurationSec: 2.5,
		durationRange: { min: 1, max: 8 },
		fields: [
			{ key: "text", label: "Heading", type: "text", default: "Next chapter" },
			{
				key: "kicker",
				label: "Kicker (small label)",
				type: "text",
				default: "",
			},
			{ key: "accent", label: "Bar color", type: "color" },
		],
		build: (args) => {
			const k = canvasScale(args.canvasSize, args.scale);
			const groupId = args.groupId ?? generateUUID();
			const shared = { ...args, groupId };
			const { enter, exit } = resolveEnterExit(args.durationSec);
				const out = Math.max(enter + 0.1, args.durationSec - exit);
			const end = Math.max(out + 0.05, args.durationSec - 0.05);
			// The pill background growing from zero paddingX reads as a native
			// grow-from-center wipe (background.paddingX is keyframable and
			// resolved in export).
			const mainChannels: TemplateChannels = {
				opacity: [
					{ atSec: 0, value: 0 },
					{ atSec: enter * 0.5, value: 1 },
					{ atSec: out, value: 1 },
					{ atSec: end, value: 0 },
				],
				"background.paddingX": [
					{ atSec: 0, value: 0 },
					{ atSec: enter, value: Math.round(60 * k) },
					{ atSec: out, value: Math.round(60 * k) },
					{ atSec: end, value: 0 },
				],
			};
			const kicker = str(args.variables, "kicker", "");
			const main = buildTemplateText({
				args: shared,
				templateId: "section-break",
				label: "Section break",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "text", "Next chapter"),
					fontSize: Math.round(11 * fontScale(args.scale)),
					fontWeight: "bold",
					color: "#0b0d12",
					textAlign: "center",
					"background.enabled": true,
					"background.color": str(args.variables, "accent", args.accent),
					"background.cornerRadius": 4,
					"background.paddingX": Math.round(60 * k),
					"background.paddingY": Math.round(18 * k),
				},
				channels: mainChannels,
			});
			// Always create the kicker element (hidden when empty) so the
			// element count is stable — the Template Controls editor maps
			// rebuilt elements onto existing siblings by index.
			const kickerChannels = fadeSlide({
				durationSec: args.durationSec,
				baseX: 0,
				baseY: -110 * k,
				fromDy: -24 * k,
				delaySec: 0.1,
			});
			const kickerElement = buildTemplateText({
				args: shared,
				templateId: "section-break",
				label: "Section break kicker",
				durationSec: args.durationSec,
				hidden: !kicker,
				params: {
					content: (kicker || "Kicker").toUpperCase(),
					fontSize: Math.round(4 * fontScale(args.scale)),
					color: "#ffffff",
					textAlign: "center",
					letterSpacing: 6,
					"transform.positionY": -110 * k,
				},
				channels: kickerChannels,
			});
			return [main, kickerElement];
		},
	},
	{
		id: "title-subtitle",
		name: "Title + subtitle",
		description: "Centered title with a smaller line under it",
		defaultDurationSec: 3.5,
		durationRange: { min: 1, max: 12 },
		fields: [
			{ key: "title", label: "Title", type: "text", default: "Big idea" },
			{
				key: "subtitle",
				label: "Subtitle",
				type: "text",
				default: "the smaller detail",
			},
			{ key: "color", label: "Title color", type: "color", default: "#ffffff" },
		],
		build: (args) => {
			const k = canvasScale(args.canvasSize, args.scale);
			const groupId = args.groupId ?? generateUUID();
			const shared = { ...args, groupId };
			const title = buildTemplateText({
				args: shared,
				templateId: "title-subtitle",
				label: "Title + subtitle",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "title", "Big idea"),
					fontSize: Math.round(14 * fontScale(args.scale)),
					fontWeight: "bold",
					color: str(args.variables, "color", "#ffffff"),
					textAlign: "center",
					"transform.positionY": -36 * k,
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: 0,
					baseY: -36 * k,
					fromDy: 36 * k,
				}),
			});
			const subtitle = buildTemplateText({
				args: shared,
				templateId: "title-subtitle",
				label: "Subtitle",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "subtitle", "the smaller detail"),
					fontSize: Math.round(6 * fontScale(args.scale)),
					color: "#ffffffcc",
					textAlign: "center",
					"transform.positionY": 48 * k,
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: 0,
					baseY: 48 * k,
					fromDy: 26 * k,
					delaySec: 0.15,
				}),
			});
			return [title, subtitle];
		},
	},
	{
		id: "quote-card",
		name: "Quote card",
		description: "Big quote with attribution pill",
		defaultDurationSec: 4.5,
		durationRange: { min: 2, max: 15 },
		fields: [
			{
				key: "quote",
				label: "Quote",
				type: "text",
				default: "The best way out is always through.",
			},
			{ key: "author", label: "Author", type: "text", default: "Robert Frost" },
			{ key: "accent", label: "Author pill color", type: "color" },
		],
		build: (args) => {
			const k = canvasScale(args.canvasSize, args.scale);
			const groupId = args.groupId ?? generateUUID();
			const shared = { ...args, groupId };
			const quote = buildTemplateText({
				args: shared,
				templateId: "quote-card",
				label: "Quote card",
				durationSec: args.durationSec,
				params: {
					content: `“${str(args.variables, "quote", "The best way out is always through.")}”`,
					fontSize: Math.round(9 * fontScale(args.scale)),
					fontStyle: "italic",
					color: "#ffffff",
					textAlign: "center",
					"transform.positionY": -30 * k,
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: 0,
					baseY: -30 * k,
					fromDy: 30 * k,
				}),
			});
			const author = buildTemplateText({
				args: shared,
				templateId: "quote-card",
				label: "Quote author",
				durationSec: args.durationSec,
				params: {
					content: `— ${str(args.variables, "author", "Robert Frost")}`,
					fontSize: Math.round(5 * fontScale(args.scale)),
					fontWeight: "bold",
					color: "#0b0d12",
					textAlign: "center",
					"transform.positionY": 90 * k,
					"background.enabled": true,
					"background.color": str(args.variables, "accent", args.accent),
					"background.cornerRadius": 50,
					"background.paddingX": Math.round(22 * k),
					"background.paddingY": Math.round(8 * k),
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: 0,
					baseY: 90 * k,
					fromDy: 24 * k,
					delaySec: 0.2,
				}),
			});
			return [quote, author];
		},
	},
	{
		id: "social-handle",
		name: "Social handle",
		description: "@handle pill, bottom-left",
		defaultDurationSec: 4,
		durationRange: { min: 1.5, max: 20 },
		fields: [
			{ key: "handle", label: "Handle", type: "text", default: "@yourchannel" },
			{ key: "accent", label: "Handle color", type: "color" },
		],
		build: (args) => {
			const { width, height } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const x = -(width / 2 - 280 * k);
			const y = height / 2 - 90 * k;
			const element = buildTemplateText({
				args,
				templateId: "social-handle",
				label: "Social handle",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "handle", "@yourchannel"),
					fontSize: Math.round(5 * fontScale(args.scale)),
					fontWeight: "bold",
					color: str(args.variables, "accent", args.accent),
					textAlign: "center",
					"transform.positionX": x,
					"transform.positionY": y,
					"background.enabled": true,
					"background.color": DARK_PILL,
					"background.cornerRadius": 50,
					"background.paddingX": Math.round(24 * k),
					"background.paddingY": Math.round(10 * k),
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: x,
					baseY: y,
					fromDx: -40 * k,
				}),
			});
			return [element];
		},
	},
	{
		id: "stat-bar",
		name: "Stat bar",
		description: "Label whose bar grows in behind it",
		defaultDurationSec: 3.5,
		durationRange: { min: 1.5, max: 10 },
		fields: [
			{ key: "text", label: "Stat", type: "text", default: "Watch time +43%" },
			{ key: "accent", label: "Bar color", type: "color" },
		],
		build: (args) => {
			const { height } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const y = height / 2 - 150 * k;
			const { enter, exit } = resolveEnterExit(args.durationSec);
				const out = Math.max(enter + 0.1, args.durationSec - exit);
			const end = Math.max(out + 0.05, args.durationSec - 0.05);
			const channels: TemplateChannels = {
				opacity: [
					{ atSec: 0, value: 0 },
					{ atSec: enter * 0.5, value: 1 },
					{ atSec: out, value: 1 },
					{ atSec: end, value: 0 },
				],
				"background.paddingX": [
					{ atSec: 0, value: 0 },
					{ atSec: enter, value: Math.round(40 * k) },
					{ atSec: out, value: Math.round(40 * k) },
					{ atSec: end, value: 0 },
				],
			};
			const element = buildTemplateText({
				args,
				templateId: "stat-bar",
				label: "Stat bar",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "text", "Watch time +43%"),
					fontSize: Math.round(7 * fontScale(args.scale)),
					fontWeight: "bold",
					color: "#0b0d12",
					textAlign: "center",
					"transform.positionY": y,
					"background.enabled": true,
					"background.color": str(args.variables, "accent", args.accent),
					"background.cornerRadius": 6,
					"background.paddingX": Math.round(40 * k),
					"background.paddingY": Math.round(12 * k),
				},
				channels,
			});
			return [element];
		},
	},
	{
		id: "bullet-list",
		name: "Bullet list",
		description: "Three lines revealed one by one",
		defaultDurationSec: 5,
		durationRange: { min: 2, max: 20 },
		fields: [
			{ key: "item1", label: "Line 1", type: "text", default: "First point" },
			{ key: "item2", label: "Line 2", type: "text", default: "Second point" },
			{ key: "item3", label: "Line 3", type: "text", default: "Third point" },
			{ key: "accent", label: "Bullet color", type: "color" },
		],
		build: (args) => {
			const { width } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const groupId = args.groupId ?? generateUUID();
			const shared = { ...args, groupId };
			const x = -(width / 2 - 480 * k);
			const lines = ["item1", "item2", "item3"].map((key, index) => {
				const y = (-90 + index * 90) * k;
				const text = str(
					args.variables,
					key,
					["First point", "Second point", "Third point"][index],
				);
				return buildTemplateText({
					args: shared,
					templateId: "bullet-list",
					label: index === 0 ? "Bullet list" : `Bullet ${index + 1}`,
					durationSec: args.durationSec,
					params: {
						content: `●  ${text}`,
						fontSize: Math.round(7 * fontScale(args.scale)),
						fontWeight: "bold",
						color: "#ffffff",
						textAlign: "left",
						"transform.positionX": x,
						"transform.positionY": y,
						"background.enabled": true,
						"background.color": DARK_PILL,
						"background.cornerRadius": 8,
						"background.paddingX": Math.round(20 * k),
						"background.paddingY": Math.round(8 * k),
					},
					channels: fadeSlide({
						durationSec: args.durationSec,
						baseX: x,
						baseY: y,
						fromDx: -50 * k,
						delaySec: 0.2 + index * 0.35,
					}),
				});
			});
			return lines;
		},
	},
	{
		id: "location-tag",
		name: "Location tag",
		description: "Place pill, top-left",
		defaultDurationSec: 3.5,
		durationRange: { min: 1.5, max: 15 },
		fields: [
			{
				key: "place",
				label: "Location",
				type: "text",
				default: "Tokyo, Japan",
			},
			{ key: "accent", label: "Pin color", type: "color" },
		],
		build: (args) => {
			const { width, height } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const x = -(width / 2 - 300 * k);
			const y = -(height / 2 - 90 * k);
			const element = buildTemplateText({
				args,
				templateId: "location-tag",
				label: "Location tag",
				durationSec: args.durationSec,
				params: {
					content: `▼ ${str(args.variables, "place", "Tokyo, Japan")}`,
					fontSize: Math.round(5 * fontScale(args.scale)),
					fontWeight: "bold",
					color: str(args.variables, "accent", args.accent),
					textAlign: "center",
					"transform.positionX": x,
					"transform.positionY": y,
					"background.enabled": true,
					"background.color": DARK_PILL,
					"background.cornerRadius": 50,
					"background.paddingX": Math.round(22 * k),
					"background.paddingY": Math.round(10 * k),
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: x,
					baseY: y,
					fromDy: -36 * k,
				}),
			});
			return [element];
		},
	},
	{
		id: "banner",
		name: "Banner",
		description: "Full-width strip along the bottom",
		defaultDurationSec: 4,
		durationRange: { min: 1.5, max: 20 },
		fields: [
			{
				key: "text",
				label: "Banner text",
				type: "text",
				default: "Breaking: something big just happened",
			},
			{ key: "accent", label: "Strip color", type: "color" },
		],
		build: (args) => {
			const { height } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const y = height / 2 - 70 * k;
			const element = buildTemplateText({
				args,
				templateId: "banner",
				label: "Banner",
				durationSec: args.durationSec,
				params: {
					content: str(
						args.variables,
						"text",
						"Breaking: something big just happened",
					),
					fontSize: Math.round(6 * fontScale(args.scale)),
					fontWeight: "bold",
					color: "#0b0d12",
					textAlign: "center",
					"transform.positionY": y,
					"background.enabled": true,
					"background.color": str(args.variables, "accent", args.accent),
					"background.cornerRadius": 0,
					"background.paddingX": Math.round(900 * k),
					"background.paddingY": Math.round(14 * k),
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: 0,
					baseY: y,
					fromDy: 80 * k,
				}),
			});
			return [element];
		},
	},
	{
		id: "end-card",
		name: "End card",
		description: "Outro: thanks + subscribe pill",
		defaultDurationSec: 5,
		durationRange: { min: 2, max: 15 },
		fields: [
			{
				key: "title",
				label: "Headline",
				type: "text",
				default: "Thanks for watching",
			},
			{ key: "cta", label: "Button text", type: "text", default: "SUBSCRIBE" },
			{ key: "accent", label: "Button color", type: "color" },
		],
		build: (args) => {
			const k = canvasScale(args.canvasSize, args.scale);
			const groupId = args.groupId ?? generateUUID();
			const shared = { ...args, groupId };
			const title = buildTemplateText({
				args: shared,
				templateId: "end-card",
				label: "End card",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "title", "Thanks for watching"),
					fontSize: Math.round(13 * fontScale(args.scale)),
					fontWeight: "bold",
					color: "#ffffff",
					textAlign: "center",
					"transform.positionY": -60 * k,
				},
				channels: popIn({ durationSec: args.durationSec }),
			});
			const cta = buildTemplateText({
				args: shared,
				templateId: "end-card",
				label: "End card button",
				durationSec: args.durationSec,
				params: {
					content: str(args.variables, "cta", "SUBSCRIBE"),
					fontSize: Math.round(6 * fontScale(args.scale)),
					fontWeight: "bold",
					color: "#0b0d12",
					textAlign: "center",
					letterSpacing: 3,
					"transform.positionY": 70 * k,
					"background.enabled": true,
					"background.color": str(args.variables, "accent", args.accent),
					"background.cornerRadius": 12,
					"background.paddingX": Math.round(36 * k),
					"background.paddingY": Math.round(14 * k),
				},
				channels: fadeSlide({
					durationSec: args.durationSec,
					baseX: 0,
					baseY: 70 * k,
					fromDy: 36 * k,
					delaySec: 0.25,
				}),
			});
			return [title, cta];
		},
	},
	{
		// Used by the Swiss grid layout (not shown in the insert gallery). Builds
		// the key-point labels as INDEPENDENT beats (no shared linkId) so each
		// can be timed to the moment it's spoken, while still restyling together.
		id: "swiss-grid-keypoint",
		name: "Swiss key points",
		description: "Key point labels for the Swiss grid layout",
		defaultDurationSec: 8,
		durationRange: { min: 1, max: 30 },
		internal: true,
		multiPoint: true,
		fields: [
			{ key: "text1", label: "Point 1", type: "text", default: "First point" },
			{ key: "text2", label: "Point 2", type: "text", default: "Second point" },
			{ key: "text3", label: "Point 3", type: "text", default: "Third point" },
			{ key: "accent", label: "Text color", type: "color", default: "#ffffff" },
		],
		build: (args) => {
			const { width, height } = args.canvasSize;
			const k = canvasScale(args.canvasSize, args.scale);
			const groupId = args.groupId ?? generateUUID();
			const color = str(args.variables, "accent", "#ffffff");
			const texts = [
				str(args.variables, "text1", "First point"),
				str(args.variables, "text2", "Second point"),
				str(args.variables, "text3", "Third point"),
			];
			return texts.map((text, index) => {
				const y = -height * 0.18 + index * height * 0.16;
				const x = -(width / 2 - width * 0.22);
				return buildTemplateText({
					args: { ...args, groupId },
					templateId: "swiss-grid-keypoint",
					label: `Key point ${index + 1}`,
					durationSec: args.durationSec,
					linkPieces: false,
					params: {
						content: text,
						fontSize: Math.round(7 * fontScale(args.scale)),
						fontWeight: "bold",
						color,
						textAlign: "left",
						"transform.positionX": x,
						"transform.positionY": y,
					},
					channels: fadeSlide({
						durationSec: args.durationSec,
						baseX: x,
						baseY: y,
						fromDx: -50 * k,
						delaySec: 0.25 + index * 0.18,
					}),
				});
			});
		},
	},
];

export function getMotionTemplate(id: string): MotionTemplate | undefined {
	return MOTION_TEMPLATES.find((t) => t.id === id);
}

/**
 * All text elements of one template instance (the elements a single build()
 * produced, sharing motionTemplate.groupId), in track order. The Template
 * Controls editor maps a rebuilt element[i] onto sibling[i].
 */
export function getMotionTemplateGroup({
	tracks,
	groupId,
}: {
	tracks: SceneTracks;
	groupId: string;
}): { trackId: string; element: TextElement }[] {
	const result: { trackId: string; element: TextElement }[] = [];
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const element of track.elements) {
			if (
				element.type === "text" &&
				element.motionTemplate?.groupId === groupId
			) {
				result.push({ trackId: track.id, element });
			}
		}
	}
	return result;
}
