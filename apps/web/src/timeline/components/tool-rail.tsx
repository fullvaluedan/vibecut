"use client";

/**
 * Premiere-style vertical tool rail on the left edge of the timeline:
 * Selection (V), Razor split, Pen mask/shape, Text, Marker.
 */

import { invokeAction } from "@/actions";
import { Button } from "@/components/ui/button";
import { usePlaceToolStore } from "@/preview/place-tool-store";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Bookmark02Icon,
	Cursor01Icon,
	PenTool03Icon,
	ScissorIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";

export function TimelineToolRail() {
	const tool = usePlaceToolStore((s) => s.tool);
	const setTool = usePlaceToolStore((s) => s.setTool);

	const railButton = (args: {
		title: string;
		icon: typeof Cursor01Icon;
		active?: boolean;
		onClick: () => void;
	}) => (
		<Button
			variant={args.active ? "secondary" : "ghost"}
			size="icon"
			className="h-8 w-8"
			title={args.title}
			onClick={args.onClick}
		>
			<HugeiconsIcon icon={args.icon} size={15} />
		</Button>
	);

	return (
		<div className="flex shrink-0 flex-col items-center gap-0.5 border-r px-0.5 py-2">
			{railButton({
				title: "Selection tool",
				icon: Cursor01Icon,
				active: tool === null,
				onClick: () => setTool(null),
			})}
			{railButton({
				title: "Razor — split the selected clip at the playhead",
				icon: ScissorIcon,
				onClick: () => invokeAction("split"),
			})}
			{railButton({
				title:
					"Pen — draw a mask on the selected clip, or a custom shape (hold the preview pen for presets)",
				icon: PenTool03Icon,
				active: tool?.kind === "pen" || tool?.kind === "shape",
				onClick: () => setTool(tool?.kind === "pen" ? null : { kind: "pen" }),
			})}
			{railButton({
				title: "Text — click the preview to place text",
				icon: TextIcon,
				active: tool?.kind === "text",
				onClick: () => setTool(tool?.kind === "text" ? null : { kind: "text" }),
			})}
			{railButton({
				title: "Marker — add/remove at the playhead (M)",
				icon: Bookmark02Icon,
				onClick: () => invokeAction("toggle-bookmark"),
			})}
		</div>
	);
}
