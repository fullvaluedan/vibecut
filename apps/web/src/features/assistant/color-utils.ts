/**
 * Small, pure color helpers for T17.4's project-derived palette. No
 * dependencies: hex in, hex out, plain HSL math for the hue shift.
 *
 * These exist so a motion template inserted by prompt reads as designed
 * against the PROJECT's own background instead of always landing the same
 * fixed white text / fixed accent regardless of what the video actually looks
 * like (see `template-defaults.ts`, the consumer).
 */

interface RGB {
	r: number;
	g: number;
	b: number;
}

interface HSL {
	h: number;
	s: number;
	l: number;
}

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

/** Accepts `#rgb` or `#rrggbb` (with or without the leading `#`). Malformed
 * input falls back to black rather than throwing: a bad color string should
 * never take down template insertion. */
export function hexToRgb(hex: string): RGB {
	const clean = hex.trim().replace(/^#/, "");
	const full =
		clean.length === 3
			? clean
					.split("")
					.map((char) => char + char)
					.join("")
			: clean.padEnd(6, "0").slice(0, 6);
	const value = Number.parseInt(full, 16);
	if (Number.isNaN(value)) return { r: 0, g: 0, b: 0 };
	return {
		r: (value >> 16) & 255,
		g: (value >> 8) & 255,
		b: value & 255,
	};
}

export function rgbToHex({ r, g, b }: RGB): string {
	const toHex = (channel: number) => clampByte(channel).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	const linear = (channel: number) => {
		const s = channel / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function rgbToHsl({ r, g, b }: RGB): HSL {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
	else if (max === gn) h = ((bn - rn) / d + 2) * 60;
	else h = ((rn - gn) / d + 4) * 60;
	return { h, s, l };
}

function hueToRgbChannel(p: number, q: number, t: number): number {
	let tt = t;
	if (tt < 0) tt += 1;
	if (tt > 1) tt -= 1;
	if (tt < 1 / 6) return p + (q - p) * 6 * tt;
	if (tt < 1 / 2) return q;
	if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
	return p;
}

function hslToRgb({ h, s, l }: HSL): RGB {
	if (s === 0) {
		const gray = clampByte(l * 255);
		return { r: gray, g: gray, b: gray };
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hn = h / 360;
	return {
		r: clampByte(hueToRgbChannel(p, q, hn + 1 / 3) * 255),
		g: clampByte(hueToRgbChannel(p, q, hn) * 255),
		b: clampByte(hueToRgbChannel(p, q, hn - 1 / 3) * 255),
	};
}

/** Matches `DARK_PILL` / the fixed dark text color already used across
 * `motion-templates/templates.ts`, so a computed foreground never introduces
 * a second "near-black" that looks slightly off next to the hardcoded one. */
const DARK_TEXT = "#0b0d12";
const LIGHT_TEXT = "#ffffff";

/** The readable text color for a background: dark text on a light
 * background, light text on a dark one. */
export function pickForeground(backgroundHex: string): string {
	return relativeLuminance(backgroundHex) > 0.5 ? DARK_TEXT : LIGHT_TEXT;
}

/** Ember's own accent hue (`#FF6E20`, the project-wide default style), used
 * when the background has no usable hue of its own (grayscale, or pure
 * black/white) so the derived accent is still a deliberate color rather than
 * an arbitrary one. */
const FALLBACK_ACCENT_HUE = 25;
const ACCENT_SATURATION = 0.72;
/**
 * Fixed at a mid-high lightness rather than derived from the background: this
 * accent has to stay legible in TWO pairings the templates already use - as
 * text over the templates' own fixed dark pill, and as a bar/pill fill under
 * their fixed dark text - and both pairings want "not too dark", regardless
 * of whether the project background itself is light or dark.
 */
const ACCENT_LIGHTNESS = 0.58;

/**
 * A vivid accent derived from the background's own hue, shifted so it reads
 * as a chosen complement rather than a copy of the background. Saturation and
 * lightness are pinned (see `ACCENT_LIGHTNESS`) so the result works as either
 * pill text or pill fill across the motion templates.
 */
export function deriveAccent(backgroundHex: string): string {
	const { h, s } = rgbToHsl(hexToRgb(backgroundHex));
	const hue = s < 0.08 ? FALLBACK_ACCENT_HUE : (h + 150) % 360;
	return rgbToHex(hslToRgb({ h: hue, s: ACCENT_SATURATION, l: ACCENT_LIGHTNESS }));
}
