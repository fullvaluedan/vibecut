"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { usePropertiesStore } from "./stores/properties-store";
import { getPropertiesConfig } from "./registry";
import { getMotionTemplate } from "@/features/motion-templates/templates";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { cn } from "@/utils/ui";
import { EmptyView } from "./empty-view";

type ElementWithTrack = { track: TimelineTrack; element: TimelineElement };

/**
 * A motion template places several text elements that linked-selection grabs
 * as one (a lower-third's two bars; every keypoint of a layout). When the WHOLE
 * selection is one such group — every element a text piece sharing one non-empty
 * `motionTemplate.groupId` of a registered template — return the piece to drive
 * the panel from, so its Template Controls open instead of the "N selected"
 * placeholder. Mixed selections (group + other clip, or two groups) → null.
 */
function singleTemplateGroupRepresentative(
	items: ElementWithTrack[],
): ElementWithTrack | null {
	if (items.length < 2) return null;
	let groupId: string | undefined;
	let templateId: string | undefined;
	let best: ElementWithTrack | null = null;
	let bestVars = -1;
	for (const it of items) {
		const el = it.element;
		if (el.type !== "text") return null;
		const mt = el.motionTemplate;
		if (!mt?.groupId) return null;
		if (groupId === undefined) {
			groupId = mt.groupId;
			templateId = mt.templateId;
		} else if (mt.groupId !== groupId) {
			return null;
		}
		const vars = Object.keys(mt.variables ?? {}).length;
		if (vars > bestVars) {
			bestVars = vars;
			best = it;
		}
	}
	if (!templateId || !getMotionTemplate(templateId)) return null;
	return best;
}

export function PropertiesPanel() {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	useEditor((e) => e.media.getAssets());
	const { selectedElements } = useElementSelection();
	const { activeTabPerType, setActiveTab } = usePropertiesStore();

	if (selectedElements.length === 0) {
		return (
			<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
				<EmptyView />
			</div>
		);
	}

	const mediaAssets = editor.media.getAssets();

	const elementsWithTracks = editor.timeline.getElementsWithTracks({
		elements: selectedElements,
	});

	// Edit a linked-selected template group via its Template Controls rather
	// than showing the bare "N selected" placeholder.
	const groupRep = singleTemplateGroupRepresentative(elementsWithTracks);

	// Effect Controls (Transform) must ALWAYS be available — even for a paired
	// (linked video+audio) clip or a multi-selection. A linked clip selects as
	// TWO elements, so the old `length > 1` early-return hid Transform whenever
	// you clicked a paired clip. Drive the panel from a representative: the
	// template group, else the first transformable visual (so a V/A pair shows
	// the VIDEO's Transform, not the audio half), else the first selected.
	const TRANSFORMABLE = ["video", "image", "sticker", "graphic", "text"];
	const visualRep = elementsWithTracks.find((e) =>
		TRANSFORMABLE.includes(e.element.type),
	);
	const elementWithTrack = groupRep ?? visualRep ?? elementsWithTracks[0];

	if (!elementWithTrack) return null;

	const { element, track } = elementWithTrack;
	const config = getPropertiesConfig({ element, mediaAssets });
	const visibleTabs = config.tabs;

	const storedTabId = activeTabPerType[element.type];
	const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
	const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
	const activeTab =
		visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];

	if (!activeTab) return null;

	return (
		<div className="panel bg-background flex h-full overflow-hidden rounded-sm border">
			<TooltipProvider delayDuration={0}>
				<div className="flex shrink-0 flex-col gap-0.5 border-r p-1 scrollbar-hidden overflow-y-auto">
					{visibleTabs.map((tab) => (
						<Tooltip key={tab.id}>
							<TooltipTrigger asChild>
								<Button
									variant={tab.id === activeTab.id ? "secondary" : "ghost"}
									size="icon"
									onClick={() =>
										setActiveTab({
											elementType: element.type,
											tabId: tab.id,
										})
									}
									aria-label={tab.label}
									className={cn(
										"shrink-0",
										"h-8 w-8",
										tab.id !== activeTab.id && "text-muted-foreground",
									)}
								>
									{tab.icon}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="right">{tab.label}</TooltipContent>
						</Tooltip>
					))}
				</div>
			</TooltipProvider>
			<ScrollArea className="flex-1 scrollbar-hidden">
				{activeTab.content({ trackId: track.id })}
			</ScrollArea>
		</div>
	);
}
