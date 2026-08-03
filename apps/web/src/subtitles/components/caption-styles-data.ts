import type { ParamValues } from "@/params";
import { DEFAULTS } from "@/timeline/defaults";

/**
 * Data for the HyperFrames-inspired caption looks (see caption-styles.tsx).
 *
 * Every look spreads CAPTION_STYLE_RESET first: the union of all param keys
 * any look touches, set to the caption style's own defaults (DEFAULTS.text).
 * Applying a look merges its params over the caption's existing params, so a
 * key a look omits would keep whatever a previously applied look wrote —
 * looks bled into each other in both directions. With the reset spread,
 * every look sets every union key explicitly and look application is
 * order-independent. Fresh-application appearance is unchanged: the reset
 * values are exactly the defaults a generated caption already carries, so
 * applying a look to default captions writes the same values it always did.
 */
export const CAPTION_STYLE_RESET: Partial<ParamValues> = {
	color: DEFAULTS.text.element.params.color,
	fontWeight: DEFAULTS.text.element.params.fontWeight,
	fontStyle: DEFAULTS.text.element.params.fontStyle,
	letterSpacing: DEFAULTS.text.letterSpacing,
	"background.enabled": DEFAULTS.text.background.enabled,
	"background.color": DEFAULTS.text.background.color,
	"background.cornerRadius": DEFAULTS.text.background.cornerRadius,
	"background.paddingX": DEFAULTS.text.background.paddingX,
	"background.paddingY": DEFAULTS.text.background.paddingY,
	"background.offsetX": DEFAULTS.text.background.offsetX,
	"background.offsetY": DEFAULTS.text.background.offsetY,
	strokeColor: DEFAULTS.text.stroke.color,
	strokeWidth: DEFAULTS.text.stroke.width,
	shadowColor: DEFAULTS.text.shadow.color,
	shadowBlur: DEFAULTS.text.shadow.blur,
	shadowOffsetX: DEFAULTS.text.shadow.offsetX,
	shadowOffsetY: DEFAULTS.text.shadow.offsetY,
};

export interface CaptionStyleLook {
	id: string;
	name: string;
	params: Partial<ParamValues>;
}

export const CAPTION_STYLES: CaptionStyleLook[] = [
	{
		id: "plain",
		name: "Plain",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#ffffff",
			fontWeight: "normal",
			fontStyle: "normal",
			"background.enabled": false,
		},
	},
	{
		id: "neon-accent",
		name: "Neon Accent",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#EAFF00",
			fontWeight: "bold",
			"background.enabled": false,
		},
	},
	{
		id: "pill-karaoke",
		name: "Pill Karaoke",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#111111",
			fontWeight: "bold",
			"background.enabled": true,
			"background.color": "#FF6E20",
			"background.cornerRadius": 24,
		},
	},
	{
		id: "weight-shift",
		name: "Weight Shift",
		params: {
			...CAPTION_STYLE_RESET,
			fontWeight: "bold",
			letterSpacing: 1.5,
			"background.enabled": false,
		},
	},
	{
		id: "editorial",
		name: "Editorial",
		params: {
			...CAPTION_STYLE_RESET,
			fontStyle: "italic",
			color: "#ffffff",
			"background.enabled": true,
			"background.color": "#000000",
			"background.cornerRadius": 4,
		},
	},
	{
		id: "highlight",
		name: "Highlight",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#111111",
			fontWeight: "bold",
			"background.enabled": true,
			"background.color": "#A3E635",
			"background.cornerRadius": 6,
		},
	},
	{
		id: "outline-pop",
		name: "Outline Pop",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#ffffff",
			fontWeight: "bold",
			fontStyle: "normal",
			"background.enabled": false,
			strokeColor: "#000000",
			strokeWidth: 6,
			shadowColor: "#000000",
			shadowBlur: 0,
			shadowOffsetX: 0,
			shadowOffsetY: 0,
		},
	},
	{
		id: "drop-shadow",
		name: "Drop Shadow",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#ffffff",
			fontWeight: "normal",
			fontStyle: "normal",
			"background.enabled": false,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 18,
			shadowOffsetX: 0,
			shadowOffsetY: 4,
		},
	},
	{
		id: "broadcast",
		name: "Broadcast",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#ffffff",
			fontWeight: "bold",
			fontStyle: "normal",
			letterSpacing: 2,
			"background.enabled": true,
			"background.color": "#1a1a1a",
			"background.cornerRadius": 2,
			"background.paddingX": 12,
			"background.paddingY": 6,
			"background.offsetX": 0,
			"background.offsetY": 0,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 8,
			shadowOffsetX: 0,
			shadowOffsetY: 2,
		},
	},
	{
		id: "minimal-mono",
		name: "Minimal Mono",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#888888",
			fontWeight: "normal",
			fontStyle: "normal",
			letterSpacing: -0.5,
			"background.enabled": false,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 0,
			shadowOffsetX: 0,
			shadowOffsetY: 0,
		},
	},
	{
		id: "highlighter-variant",
		name: "Highlighter",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#000000",
			fontWeight: "normal",
			fontStyle: "normal",
			"background.enabled": true,
			"background.color": "#FFFF00",
			"background.cornerRadius": 20,
			"background.paddingX": 8,
			"background.paddingY": 4,
			"background.offsetX": 0,
			"background.offsetY": 0,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 0,
			shadowOffsetX: 0,
			shadowOffsetY: 0,
		},
	},
	{
		id: "cinema-bar",
		name: "Cinema Bar",
		params: {
			...CAPTION_STYLE_RESET,
			color: "#ffffff",
			fontWeight: "normal",
			fontStyle: "normal",
			"background.enabled": true,
			"background.color": "#000000",
			"background.cornerRadius": 0,
			"background.paddingX": 16,
			"background.paddingY": 8,
			"background.offsetX": 0,
			"background.offsetY": -2,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 12,
			shadowOffsetX: 0,
			shadowOffsetY: 3,
		},
	},
];
