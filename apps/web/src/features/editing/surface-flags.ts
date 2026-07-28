/**
 * Hidden per Dan's 2026-07-19 roadmap decision D4/D6, see docs/plans/2026-07-19-002.
 *
 * Every surface gated by a const below is PARKED, not deleted: the component
 * and its logic stay in the tree exactly as they are, these flags just stop
 * them from being mounted or listed. Flip a const back to its opposite value
 * to bring a surface back on - nothing else in the app needs to change.
 */

import type { Tab } from "@/components/editor/panels/assets/assets-panel-store";

/**
 * Left-panel tab keys hidden from the tab rail and the fallback logic in
 * `assets-panel-store.tsx`. HyperFrames is parked (D6); Sounds and Effects
 * are hidden because they are not useful right now (D4).
 */
export const HIDDEN_ASSET_TABS: readonly Tab[] = [
	"hyperframes",
	"sounds",
	"effects",
];

/**
 * RUN HYPERFRAMES toolbar cluster in `timeline/components/timeline-toolbar.tsx`:
 * the run button, its dropdown (Run Entire Timeline / Run Selected Video ONLY),
 * Versions x3, the reopen-drafts button, the run Log popover, and its Stop
 * button all live inside `RunHyperframesButton` - hiding that one mount hides
 * the whole cluster.
 */
export const HIDE_RUN_HYPERFRAMES_CLUSTER = true;

/** The "Run through HyperFrames" clip context-menu item (per-clip generation). */
export const HIDE_RUN_HYPERFRAMES_CONTEXT_MENU_ITEM = true;

/** The assistant prompt box mounted in the preview toolbar. */
export const HIDE_ASSISTANT_PROMPT = true;

/** The HyperFrames drafts panel takeover of the empty inspector. */
export const HIDE_HYPERFRAMES_DRAFTS_PANEL = true;

/**
 * AI CUT menu (toolbar dropdown) and the Director dock idle card both slim to
 * exactly two entries: "AI CUT" (the Director run) and "Remove silences".
 * Auto-assemble and Highlight are hidden, not deleted - their run functions
 * and review panels are untouched.
 */
export const HIDE_AUTO_ASSEMBLE_ACTION = true;
export const HIDE_HIGHLIGHT_ACTION = true;
