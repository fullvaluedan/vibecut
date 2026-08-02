import type { SceneTracks, TimelineTrack } from "@/timeline";
import {
	buildTransitionRenderPlan,
	EMPTY_TRANSITION_PLAN,
	type TransitionRenderPlan,
} from "@/timeline/transitions";
import type { MediaAsset } from "@/media/types";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { SolidColorNode } from "./nodes/solid-color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import { isSolidColorAsset, resolveSolidElementColor } from "@/media/solid-color";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
	mainTrackId,
	transitionPlan,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	/** T19.3: transitions are a MAIN-TRACK feature; other lanes ignore the plan. */
	mainTrackId?: string;
	transitionPlan: TransitionRenderPlan;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });
		const isMainTrack = track.id === mainTrackId;
		const transitionsFor = ({ elementId }: { elementId: string }) =>
			isMainTrack ? transitionPlan.rolesByElementId.get(elementId) : undefined;

		for (const element of elements) {
			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset?.file || !mediaAsset?.url) {
					continue;
				}

				// Alpha WebMs (AI overlays or imported transparent video) can't be
				// decoded with transparency by WebCodecs — they'd render as opaque
				// black. The DOM preview layer / ffmpeg export composite handles
				// them instead (see overlay-preview-layer.tsx).
				if (
					element.type === "video" &&
					(element.framecutAi || mediaAsset.hasAlpha)
				) {
					continue;
				}

				if (element.type === "video" && mediaAsset.type === "video") {
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: mediaAsset.url,
							file: mediaAsset.file,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							retime: element.retime,
							crop: element.crop,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							transitions: transitionsFor({ elementId: element.id }),
							...(isMainTrack &&
							transitionPlan.secondarySinkElementIds.has(element.id)
								? { decodeConsumerId: element.id }
								: {}),
						}),
					);
				}
				if (
					element.type === "image" &&
					mediaAsset.type === "image" &&
					isSolidColorAsset({ asset: mediaAsset })
				) {
					// A Solid paints a flat fill instead of decoding mediaAsset.url; see
					// media/solid-color.ts for why the placeholder file/url above still
					// have to exist even though they're unused here.
					nodes.push(
						new SolidColorNode({
							color: resolveSolidElementColor({ element, mediaAsset }),
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							transitions: transitionsFor({ elementId: element.id }),
						}),
					);
				} else if (element.type === "image" && mediaAsset.type === "image") {
					nodes.push(
						new ImageNode({
							url: mediaAsset.url,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							crop: element.crop,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							transitions: transitionsFor({ elementId: element.id }),
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}
		}

		if (isMainTrack) {
			// T19.3 dip to black/white: no source overlap, just a full-canvas
			// colour layer whose alpha ramps 0 -> 1 -> 0 across the cut. Pushed
			// AFTER the main track's own clips so it covers them, and still
			// inside the main track's slot so it never blankets an overlay
			// title (CapCut behaviour: a main-track transition is main-track).
			for (const dip of transitionPlan.dipLayers) {
				nodes.push(
					new SolidColorNode({
						color: dip.color,
						duration: dip.durationTicks,
						timeOffset: dip.startTicks,
						trimStart: 0,
						trimEnd: 0,
						transform: buildTransformFromParams({ params: {} }),
						opacity: 1,
						blendMode: "normal",
						effects: [],
						masks: [],
						transitions: { head: dip.ramp },
					}),
				);
			}
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		// A Solid has no decodable source - its file/url are the 1x1 gray
		// placeholder SVG (see media/solid-color.ts). Blurring a flat color is that
		// same flat color, so the backdrop is just the solid's color filling the
		// frame. Route it to a full-frame SolidColorNode (identity transform, so it
		// covers the frame regardless of the foreground's own transform) instead of
		// decoding the placeholder into a uniform gray backdrop. Mirrors the solid
		// guard on the foreground path in buildTrackNodes.
		if (
			element.type === "image" &&
			mediaAsset.type === "image" &&
			isSolidColorAsset({ asset: mediaAsset })
		) {
			nodes.push(
				new SolidColorNode({
					color: resolveSolidElementColor({ element, mediaAsset }),
					duration: element.duration,
					timeOffset: element.startTime,
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
					transform: buildTransformFromParams({ params: {} }),
					opacity: 1,
					blendMode: "normal",
					effects: [],
					masks: [],
				}),
			);
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	// T19.3: ONE plan serves preview and export, because both go through here.
	const transitionPlan = mainTrack
		? buildTransitionRenderPlan({ elements: mainTrack.elements })
		: EMPTY_TRANSITION_PLAN;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
		mainTrackId: mainTrack?.id,
		transitionPlan,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
