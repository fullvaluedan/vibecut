/**
 * T19.3 TRANSITIONS v1 (dissolve family).
 *
 * A transition is an ENTITY attached to a main-track BOUNDARY, not an overlap.
 * The timeline model stays overlap-free (see `timeline/placement/overlap.ts`,
 * whose invariant this round deliberately does not touch); the renderer
 * synthesizes the overlap by extending both neighbours' sampling windows across
 * the transition window (see `services/renderer/transition-window.ts`).
 *
 * STORAGE LOCATION (decided after reading serialization, see
 * `services/storage/types.ts`): the spec lives in an OPTIONAL FIELD ON THE
 * ELEMENT, not in a track-level boundary map.
 *
 *   - `SerializedScene` is `Omit<TScene, "createdAt"|"updatedAt">`, i.e. the
 *     scene's tracks are persisted as a structural JSON clone. An optional
 *     element field therefore round-trips with ZERO serializer work and
 *     "absent = no transition" is automatic for every project written before
 *     this round - the same additive pattern already used by `crop`,
 *     `retime.reversed`, `retime.curve` and `masks`. No storage migration is
 *     needed (and none was added: `CURRENT_PROJECT_VERSION` is untouched).
 *   - Every element-preserving edit (move, trim, ripple, magnet, group move)
 *     spreads the element, so a spec follows the clip that owns it for free. A
 *     track-level map keyed by boundary would need explicit maintenance in each
 *     of those code paths, and a `Map` needs bespoke (de)serialization.
 *
 * OWNERSHIP RULE (unambiguous, enforced by `reconcileTrackTransitions`):
 *   - A JOIN's transition always lives in the RIGHT neighbour's
 *     `transitionIn`. Kinds: crossDissolve / dipToBlack / dipToWhite.
 *   - `transitionOut` is exclusively the tail FADE, and only on a clip with no
 *     abutting right neighbour. `transitionIn` on a clip with no abutting left
 *     neighbour is the head FADE.
 *   - So `fade` is the single-sided kind (timeline start/end or against a gap)
 *     and the other three require two abutting clips, exactly as the round-19
 *     plan specifies.
 */

export type TransitionKind =
	| "crossDissolve"
	| "dipToBlack"
	| "dipToWhite"
	| "fade";

export interface TransitionSpec {
	id: string;
	kind: TransitionKind;
	durationSec: number;
}

/** The two element fields a spec can live in. */
export type TransitionField = "transitionIn" | "transitionOut";

export const DEFAULT_TRANSITION_DURATION_SEC = 0.5;

/** Picker presets. A custom value is typed into the NumberField beside them. */
export const TRANSITION_DURATION_PRESETS_SEC = [0.25, 0.5, 1] as const;

/**
 * Below this a transition is shorter than a couple of frames at any sane rate,
 * so a boundary that cannot fit it offers no transition at all.
 */
export const MIN_TRANSITION_DURATION_SEC = 0.05;

/** Hard ceiling regardless of how long the neighbours are. */
export const MAX_TRANSITION_DURATION_SEC = 5;

export interface TransitionKindInfo {
	kind: TransitionKind;
	label: string;
	/** Short picker blurb. */
	description: string;
	/** True when the kind needs two abutting clips. */
	requiresJoin: boolean;
}

export const TRANSITION_KIND_INFO: Record<TransitionKind, TransitionKindInfo> = {
	crossDissolve: {
		kind: "crossDissolve",
		label: "Cross dissolve",
		description: "Both clips overlap and blend.",
		requiresJoin: true,
	},
	dipToBlack: {
		kind: "dipToBlack",
		label: "Dip to black",
		description: "Fall through black at the cut.",
		requiresJoin: true,
	},
	dipToWhite: {
		kind: "dipToWhite",
		label: "Dip to white",
		description: "Flash through white at the cut.",
		requiresJoin: true,
	},
	fade: {
		kind: "fade",
		label: "Fade",
		description: "Fade in or out against nothing.",
		requiresJoin: false,
	},
};

/**
 * v1 keeps the HARD AUDIO CUT at the join. Audio crossfade would reuse T18.3's
 * fade machinery and is a follow-up, not this task. Surfaced in the picker so
 * the behaviour is never a surprise.
 */
export const TRANSITION_AUDIO_NOTE = "Audio cuts at the join for now.";

export const DIP_COLOR_BY_KIND: Partial<Record<TransitionKind, string>> = {
	dipToBlack: "#000000",
	dipToWhite: "#ffffff",
};
