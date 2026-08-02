import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
	mediaId: string;
	/**
	 * T19.3: opt this node out of the shared per-mediaId decode sink. Set only
	 * for the right side of a crossDissolve whose two clips were cut from the
	 * SAME file, where one sink would be seeked to two different times every
	 * frame (see services/video-cache/service.ts).
	 */
	decodeConsumerId?: string;
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVisualSourceNodeState
> {}
