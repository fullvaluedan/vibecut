"use client";

import { useState, useEffect, useRef } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditor } from "@/editor/use-editor";
import { formatTimecode } from "opencut-wasm";
import { invokeAction } from "@/actions";
import { EditableTimecode } from "@/components/editable-timecode";
import { Button } from "@/components/ui/button";
import {
	FullScreenIcon,
	PauseIcon,
	PenTool03Icon,
	PlayIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { usePlaceToolStore } from "@/preview/place-tool-store";
import { HugeiconsIcon } from "@hugeicons/react";
import { Separator } from "@/components/ui/separator";
import {
	Select,
	SelectTrigger,
	SelectContent,
	SelectItem,
	SelectSeparator,
} from "@/components/ui/select";
import { PREVIEW_ZOOM_PRESETS } from "@/preview/zoom";
import { usePreviewViewport } from "./preview-viewport";
import { GridPopover } from "./guide-popover";
import { usePreviewStore } from "@/preview/preview-store";
import type { MediaTime } from "@/wasm";

export function PreviewToolbar({
	onToggleFullscreen,
}: {
	onToggleFullscreen: () => void;
}) {
	return (
		<div className="grid grid-cols-[1fr_auto_1fr] items-center pb-3 pt-5 px-5">
			<TimecodeDisplay />
			<PlayPauseButton />
			<div className="justify-self-end flex items-center gap-2.5">
				<TextToolButton />
				<ShapeToolButton />
				<Separator orientation="vertical" className="h-4" />
				<ZoomSelect />
				<Separator orientation="vertical" className="h-4" />
				{/* v0.4.0 */}
				{/* <GridPopover>
					<Button
						variant={activeGuideDefinition ? "secondary" : "text"}
						size="icon"
					>
						{activeGuideDefinition ? (
							activeGuideDefinition.renderTriggerIcon()
						) : (
							<HugeiconsIcon icon={GridTableIcon} />
						)}
					</Button>
				</GridPopover> */}
				<Button variant="text" onClick={onToggleFullscreen}>
					<HugeiconsIcon icon={FullScreenIcon} />
				</Button>
			</div>
		</div>
	);
}

function TimecodeDisplay() {
	const editor = useEditor();
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());
	const fps = useEditor((e) => e.project.getActive().settings.fps);
	const [currentTime, setCurrentTime] = useState<MediaTime>(() =>
		editor.playback.getCurrentTime(),
	);

	useEffect(() => {
		const unsubscribeUpdate = editor.playback.onUpdate(setCurrentTime);
		const unsubscribeSeek = editor.playback.onSeek(setCurrentTime);
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
		};
	}, [editor.playback]);

	return (
		<div className="flex items-center">
			<EditableTimecode
				time={currentTime}
				duration={totalDuration}
				format="HH:MM:SS:FF"
				fps={fps}
				onTimeChange={({ time }) => editor.playback.seek({ time })}
				className="text-center"
			/>
			<span className="text-muted-foreground px-2 font-mono text-xs">/</span>
			<span className="text-muted-foreground font-mono text-xs">
				{formatTimecode({
					time: totalDuration,
					format: "HH:MM:SS:FF",
					rate: fps,
				})}
			</span>
		</div>
	);
}

function ZoomSelect() {
	const { isAtFit, zoomPercent, fitToScreen, setViewportPercent } =
		usePreviewViewport();

	const displayLabel = isAtFit ? "Fit" : `${zoomPercent}%`;

	const onValueChange = (value: string) => {
		if (value === "fit") {
			fitToScreen();
		} else {
			setViewportPercent({ percent: Number(value) });
		}
	};

	return (
		<Select
			value={isAtFit ? "fit" : String(zoomPercent)}
			onValueChange={onValueChange}
		>
			<SelectTrigger className="tabular-nums">{displayLabel}</SelectTrigger>
			<SelectContent>
				<SelectItem value="fit">Fit</SelectItem>
				<SelectSeparator />
				{PREVIEW_ZOOM_PRESETS.map((preset) => (
					<SelectItem key={preset} value={String(preset)}>
						{preset}%
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function TextToolButton() {
	const tool = usePlaceToolStore((s) => s.tool);
	const toggleTextTool = usePlaceToolStore((s) => s.toggleTextTool);
	const setTool = usePlaceToolStore((s) => s.setTool);
	const isActive = tool?.kind === "text";

	useEffect(() => {
		if (!tool) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setTool(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [tool, setTool]);

	return (
		<Button
			variant={isActive ? "secondary" : "text"}
			size="icon"
			title="Text tool — click anywhere on the preview to add text (Esc cancels)"
			onClick={toggleTextTool}
		>
			<HugeiconsIcon icon={TextIcon} />
		</Button>
	);
}

const FLYOUT_HOLD_MS = 350;
const FLYOUT_SHAPES = [
	{ definitionId: "rectangle", label: "Rectangle" },
	{ definitionId: "ellipse", label: "Ellipse" },
	{ definitionId: "polygon", label: "Polygon" },
	{ definitionId: "star", label: "Star" },
];

/**
 * Premiere-style pen tool button: click to draw a custom shape on the
 * preview (click points, double-click to close); click-and-HOLD to fly out
 * the preset shapes.
 */
function ShapeToolButton() {
	const tool = usePlaceToolStore((s) => s.tool);
	const setTool = usePlaceToolStore((s) => s.setTool);
	const [flyoutOpen, setFlyoutOpen] = useState(false);
	const holdTimer = useRef<number | null>(null);
	const openedByHold = useRef(false);
	const isActive = tool?.kind === "pen" || tool?.kind === "shape";

	const onPointerDown = () => {
		openedByHold.current = false;
		holdTimer.current = window.setTimeout(() => {
			openedByHold.current = true;
			setFlyoutOpen(true);
		}, FLYOUT_HOLD_MS);
	};
	const onPointerUp = () => {
		if (holdTimer.current !== null) {
			window.clearTimeout(holdTimer.current);
			holdTimer.current = null;
		}
		if (!openedByHold.current) {
			setTool(tool?.kind === "pen" ? null : { kind: "pen" });
		}
	};

	return (
		<DropdownMenu open={flyoutOpen} onOpenChange={setFlyoutOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					variant={isActive ? "secondary" : "text"}
					size="icon"
					title="Pen tool — click to draw a custom shape; hold for preset shapes"
					onPointerDown={onPointerDown}
					onPointerUp={onPointerUp}
				>
					<HugeiconsIcon icon={PenTool03Icon} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => setTool({ kind: "pen" })}>
					Pen — draw a custom shape
				</DropdownMenuItem>
				{FLYOUT_SHAPES.map((shape) => (
					<DropdownMenuItem
						key={shape.definitionId}
						onClick={() =>
							setTool({ kind: "shape", definitionId: shape.definitionId })
						}
					>
						{shape.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function PlayPauseButton() {
	const isPlaying = useEditor((e) => e.playback.getIsPlaying());

	return (
		<Button
			variant="text"
			size="icon"
			onClick={() => invokeAction("toggle-play")}
		>
			<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} />
		</Button>
	);
}
