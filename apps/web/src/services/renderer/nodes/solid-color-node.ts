import { createCanvasSurface } from "../canvas-utils";
import {
	VisualNode,
	type ResolvedVisualNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface SolidColorNodeParams extends VisualNodeParams {
	color: string;
}

/**
 * VibeCut (W7): the render seam for a "Solid" (see media/solid-color.ts). A
 * solid has no decodable source, so instead of an `ImageNode` decoding a
 * file, this node paints a flat fill on demand - modeled directly on
 * `GraphicNode.getSource()`, which already does the same "draw, don't
 * decode" trick for shape graphics. The generic VisualNode/transform/mask
 * pipeline in compositor/frame-descriptor.ts treats the two identically, so
 * a solid gets transform, masks, effects and blending for free.
 */
export class SolidColorNode extends VisualNode<
	SolidColorNodeParams,
	ResolvedVisualNodeState
> {
	private cachedKey: string | null = null;
	private cachedSource: OffscreenCanvas | null = null;

	getSource({ width, height }: { width: number; height: number }): OffscreenCanvas {
		const cacheKey = `${this.params.color}:${width}x${height}`;
		if (this.cachedSource && this.cachedKey === cacheKey) {
			return this.cachedSource;
		}

		const { canvas, context } = createCanvasSurface({ width, height });
		context.fillStyle = this.params.color;
		context.fillRect(0, 0, width, height);

		this.cachedKey = cacheKey;
		this.cachedSource = canvas;
		return canvas;
	}
}
