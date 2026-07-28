import type { FrameRate } from "opencut-wasm";
import type { TextStyle } from "@/features/text-styles/types";
import type { RunLedgerRecord } from "@/features/ai-generate/director/run-ledger";
import type { TScene } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: MediaTime;
	createdAt: Date;
	updatedAt: Date;
}

export interface TProjectSettings {
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: MediaTime;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	version: number;
	timelineViewState?: TTimelineViewState;
	/**
	 * VibeCut: named, reusable text looks saved by the creator. Optional so
	 * every project saved before the feature existed still loads; readers go
	 * through `readTextStyles` in `features/text-styles/project-styles.ts`,
	 * which treats a missing list as empty.
	 */
	textStyles?: TextStyle[];
	/**
	 * VibeCut: the Director's per-project run ledger (taste v2) - an append-
	 * capped history of past "cut" review runs, feeding compact per-category
	 * notes back into the Director prompt. Optional so every project saved
	 * before this feature still loads; readers go through `readRunLedger` in
	 * `features/ai-generate/director/run-ledger.ts`, which treats a missing
	 * list as empty.
	 */
	runLedger?: RunLedgerRecord[];
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
