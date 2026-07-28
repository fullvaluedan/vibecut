import type { ParamValue } from "@/params";
import { getBuiltInElementParams } from "@/params/registry";
import type { TextElement } from "@/timeline";
import { TEXT_STYLE_PARAM_KEYS, isTextStyleParamKey } from "./style-param-keys";
import type { TextStyle } from "./types";

export {
	TEXT_STYLE_PARAM_KEYS,
	isTextStyleParamKey,
	type TextStyleParamKey,
} from "./style-param-keys";

/**
 * Registry defaults for the appearance keys, so a captured style is always a
 * COMPLETE look. Without this, a style saved off an element that never touched
 * (say) the backer box would leave the backer box alone on apply, and the same
 * style would produce different results depending on what the target element
 * happened to have set. A style should look the same everywhere it lands.
 */
export function getTextStyleParamDefaults(): Record<string, ParamValue> {
	const defaults: Record<string, ParamValue> = {};
	for (const param of getBuiltInElementParams({ type: "text" })) {
		if (isTextStyleParamKey({ key: param.key })) {
			defaults[param.key] = param.default;
		}
	}
	return defaults;
}

/** Read the appearance-only slice of an element, filling gaps with defaults. */
export function captureTextStyleParams({
	element,
}: {
	element: Pick<TextElement, "params">;
}): Record<string, ParamValue> {
	const captured = getTextStyleParamDefaults();
	for (const key of TEXT_STYLE_PARAM_KEYS) {
		const value = element.params?.[key];
		if (value !== undefined) {
			captured[key] = value;
		}
	}
	return captured;
}

/**
 * The patch handed to UpdateElementsCommand: the element's own params with the
 * style's appearance keys layered on top, so `content` and every transform key
 * survive untouched. Keys the style does not carry (an older or hand-edited
 * record) are left exactly as they were rather than reset.
 */
export function buildTextStylePatch({
	element,
	style,
}: {
	element: Pick<TextElement, "params">;
	style: Pick<TextStyle, "params">;
}): { params: Record<string, ParamValue> } {
	const nextParams: Record<string, ParamValue> = { ...(element.params ?? {}) };
	for (const [key, value] of Object.entries(style.params ?? {})) {
		if (!isTextStyleParamKey({ key })) continue;
		if (value === undefined) continue;
		nextParams[key] = value;
	}
	return { params: nextParams };
}
