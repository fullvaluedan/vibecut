/**
 * T18.5: home-page tiles deep-link into the editor via `?open=<panel>` (e.g.
 * `/editor/<id>?open=director`). Pure param -> store-action mapping so the
 * logic is unit-testable without mounting the editor. The page component
 * reads `?open`, calls `resolveOpenParamAction` to decide which store to
 * touch, then strips the param from the URL (see page.tsx `useDeepLinkOpen`).
 */

export const OPEN_PARAM_VALUES = ["director", "transcript", "captions"] as const;

export type OpenParam = (typeof OPEN_PARAM_VALUES)[number];

/** Unknown or missing values are ignored (return null), never guessed. */
export function parseOpenParam(value: string | null | undefined): OpenParam | null {
	if (!value) return null;
	return (OPEN_PARAM_VALUES as readonly string[]).includes(value)
		? (value as OpenParam)
		: null;
}

export type OpenParamAction =
	| { store: "director" }
	| { store: "assets"; tab: "transcript" | "captions" };

/** Maps a validated open param to the store it should touch. Pure. */
export function resolveOpenParamAction(param: OpenParam): OpenParamAction {
	if (param === "director") return { store: "director" };
	return { store: "assets", tab: param };
}
