/**
 * THE load-bearing rule of this feature: a text style is APPEARANCE ONLY.
 *
 * Captured: everything that decides how the words look (typeface, size,
 * weight, slant, underline, fill color, spacing, alignment, and the whole
 * backer-box group).
 *
 * Deliberately NOT captured: `content` (the words themselves), every
 * `transform.*` key (position, scale, rotation), `opacity` and `blendMode`
 * (compositing, not typography), and anything living outside `params` such as
 * duration, animations, or the motion-template marker. Saving a style off one
 * lower third and applying it to another must never move the second one or
 * rewrite its text.
 *
 * Kept in its own import-free leaf module because the storage service reads
 * it (through `normalizeTextStyles`) and must not drag the params registry,
 * and with it the rendering and text-layout modules, into that chain.
 */
export const TEXT_STYLE_PARAM_KEYS = [
	"fontFamily",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"color",
	"letterSpacing",
	"lineHeight",
	"textAlign",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
] as const;

export type TextStyleParamKey = (typeof TEXT_STYLE_PARAM_KEYS)[number];

const TEXT_STYLE_PARAM_KEY_SET: ReadonlySet<string> = new Set(
	TEXT_STYLE_PARAM_KEYS,
);

export function isTextStyleParamKey({ key }: { key: string }): boolean {
	return TEXT_STYLE_PARAM_KEY_SET.has(key);
}
