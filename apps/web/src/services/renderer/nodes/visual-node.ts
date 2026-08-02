import { BaseNode } from "./base-node";
import type { Effect, EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, Transform } from "@/rendering";
import type { CropRect, RetimeConfig, VisualElement } from "@/timeline";
import type { TransitionRoles } from "@/timeline/transitions";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	/** T18.1: only meaningful for VideoNode/ImageNode; see rendering/crop.ts. */
	crop?: CropRect;
	/**
	 * T19.3: this clip's role(s) in a main-track transition - the opacity ramps
	 * and, for a crossDissolve, how far outside its own span it may render.
	 * Absent on every node that is not part of a transition, which is what
	 * keeps the resolve.ts visibility gate unchanged for them.
	 */
	transitions?: TransitionRoles;
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
