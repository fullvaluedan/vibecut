/**
 * Pure insert-spec builder for placed authored HyperFrames segments, split out
 * of place-hyperframes-render.ts so the field rules (above all the audio
 * invariant) are unit-testable without the editor/command imports - mirrors
 * the variant-picker-store split.
 */

export interface SegmentAssetInfo {
	assetId: string;
	startSec: number;
	durationSec: number;
	/** Whether the rendered file carries an audio stream at all. */
	hasAudio: boolean;
	compId?: string;
	templateId?: string;
	name?: string;
	brief?: string;
}

export interface SegmentInsertSpec {
	assetId: string;
	name?: string;
	startSec: number;
	durationSec: number;
	/** ALWAYS false for authored segments - see buildSegmentInsertSpecs. */
	isSourceAudioEnabled: boolean;
	compId?: string;
	templateId: string;
	brief?: string;
}

/**
 * Map imported segment assets to insert specs. THE AUDIO INVARIANT: audio is
 * NEVER taken from render segments - export muxes audio from the SOURCE
 * footage (the composite route maps only the base render's audio, `0:a?`), so
 * a segment that happens to carry audio (SFX baked into a render) must stay
 * muted on the timeline or it would double into the export's base mix.
 */
export function buildSegmentInsertSpecs(
	assets: SegmentAssetInfo[],
): SegmentInsertSpec[] {
	return assets.map((a) => ({
		assetId: a.assetId,
		name: a.name,
		startSec: Math.max(0, a.startSec),
		durationSec: a.durationSec,
		isSourceAudioEnabled: false,
		compId: a.compId,
		templateId: a.templateId ?? "authored:chunk",
		brief: a.brief,
	}));
}
