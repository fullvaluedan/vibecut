import type { ParamValue } from "@/params";

/**
 * A saved LOOK, not a saved element. Premiere calls this a Linked Style; ours
 * is a deliberate one-shot apply, not a live binding, so editing a style later
 * never reaches back into text you already styled.
 */
export interface TextStyle {
	id: string;
	name: string;
	/** Appearance params only. See TEXT_STYLE_PARAM_KEYS for the exact list. */
	params: Record<string, ParamValue>;
	/** ISO string, so the record stays plain JSON through IndexedDB. */
	createdAt: string;
}
