/**
 * Decide which RUN HYPERFRAMES engine a run should actually use.
 *
 * The native/cinematic plan path can only place the five built-in templates, so
 * it needs at least one template checked. The AUTHORED engine renders from the
 * picked styles/assets + direction and needs no template at all. So when the user
 * is on native/cinematic but has checked NO template yet picked a style/asset (e.g.
 * "Swiss Grid") or written a Direction, fall back to the authored engine instead of
 * dead-ending on "check a template" — that's how you use a style/block without a
 * template. Only when there is NOTHING to work from do we surface the gate error.
 *
 * Pure (no store/DOM/wasm imports) so it is bun-unit-testable.
 */
export type HfEngine = "native" | "cinematic" | "authored";

export type HfEngineDecision =
	| { engine: HfEngine; fellBackToAuthored: boolean }
	| { error: string };

export function resolveHfRunEngine({
	engine,
	allowedTemplateCount,
	hasDirection,
	pickedAssetCount,
}: {
	engine: HfEngine;
	/** Templates currently CHECKED in the panel (catalog minus the deny-list). */
	allowedTemplateCount: number;
	/** The user typed a non-empty Direction. */
	hasDirection: boolean;
	/** Registry assets the user PICKED (promptHfAssets) to feed the brief. */
	pickedAssetCount: number;
}): HfEngineDecision {
	// Authored is un-gated and already handles an empty selection gracefully.
	if (engine === "authored") {
		return { engine, fellBackToAuthored: false };
	}
	// A native/cinematic run with at least one template runs as chosen.
	if (allowedTemplateCount > 0) {
		return { engine, fellBackToAuthored: false };
	}
	// No template checked: if the user gave guidance (a picked style/asset or a
	// Direction), render it via the authored engine rather than forcing a template.
	if (hasDirection || pickedAssetCount > 0) {
		return { engine: "authored", fellBackToAuthored: true };
	}
	return {
		error:
			"Give HyperFrames something to work from: check at least one template, pick a style/asset (☆), or write a Direction.",
	};
}
