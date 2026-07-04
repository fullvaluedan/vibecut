/**
 * Speaker-aware placement math for HyperFrames overlays.
 *
 * The speaker in a talking-head shot is NOT reliably centered and can MOVE during
 * a clip, so a single-frame position check is unsafe — a graphic placed where the
 * speaker isn't at t=0 can be covered by them at t=2s. We sample several frames
 * across the clip (browser-side, via the director frame sampler), have a vision
 * model report which horizontal third(s) the speaker occupies in EACH frame, then
 * reduce that here: the safe zone is the set of thirds clear in EVERY frame (the
 * complement of the union of speaker positions). If the speaker roams the whole
 * width, no vertical column is safe and we fall back to a lower-third band, which
 * clears the face regardless of horizontal position.
 *
 * Pure + deterministic (no IO) so it is unit-tested directly.
 */

export type HZone = "left" | "center" | "right";

export interface FrameSpeaker {
	/** Source time of the sampled frame, seconds. */
	timeSec: number;
	/** Horizontal thirds the speaker occupies in THIS frame (may be several). */
	occupies: HZone[];
}

export interface SafeZone {
	/** Union of thirds the speaker occupies across ALL sampled frames. */
	occupiedAcrossClip: HZone[];
	/** Thirds clear in EVERY sampled frame (safe for the whole duration). */
	safeColumns: HZone[];
	/** True when the speaker roams the full width — only a horizontal band is safe. */
	bandOnly: boolean;
	/** A brief-ready instruction naming the safe zone for the skill. */
	instruction: string;
}

const ALL: HZone[] = ["left", "center", "right"];

/**
 * Reduce per-frame speaker positions into a single safe zone for the whole clip.
 * Empty input (no frames / detection failed) yields the conservative lower-third
 * band so the caller still gets a usable, movement-proof instruction.
 */
export function computeSafeZone(frames: readonly FrameSpeaker[]): SafeZone {
	const occupied = new Set<HZone>();
	for (const f of frames) {
		for (const z of f.occupies) occupied.add(z);
	}
	// The speaker can MOVE between samples, so the unsafe region is the contiguous
	// SPAN from the leftmost to the rightmost third they were seen in — they
	// crossed the columns in between. Seen in {left, right} ⇒ they passed through
	// center ⇒ all three unsafe. So occupiedAcrossClip is the span, and the safe
	// columns are its complement.
	const idxs = ALL.map((z, i) => (occupied.has(z) ? i : -1)).filter((i) => i >= 0);
	const lo = idxs.length ? Math.min(...idxs) : Number.POSITIVE_INFINITY;
	const hi = idxs.length ? Math.max(...idxs) : Number.NEGATIVE_INFINITY;
	const occupiedAcrossClip = ALL.filter((_, i) => i >= lo && i <= hi);
	const safeColumns = ALL.filter((_, i) => i < lo || i > hi);

	// No frames, or the speaker's span covers every column → no vertical column is
	// safe for the whole clip; only a horizontal band is.
	const bandOnly = frames.length === 0 || safeColumns.length === 0;

	let instruction: string;
	if (bandOnly) {
		instruction =
			frames.length === 0
				? "Speaker position unknown — place the graphic in a LOWER-THIRD band (bottom ~22% of the frame), which clears the speaker's face regardless of where they stand or move."
				: "The speaker moves across the full width of the frame — place the graphic in a LOWER-THIRD band (bottom ~22%), the only zone that stays clear of the face throughout the clip.";
	} else {
		const occ = occupiedAcrossClip.length
			? occupiedAcrossClip.join(" + ")
			: "center";
		const safe = safeColumns.join(" and ");
		instruction = `The speaker stays within the ${occ} region across this clip; the ${safe} third${safeColumns.length > 1 ? "s" : ""} stay clear the whole time — place the graphic there (or use a lower-third band). Do not drift into the ${occ} region.`;
	}

	return { occupiedAcrossClip, safeColumns, bandOnly, instruction };
}
