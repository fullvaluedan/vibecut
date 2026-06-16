"use client";

import { useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Bookmark02Icon,
	Delete02Icon,
	Download01Icon,
} from "@hugeicons/core-free-icons";
import { DEFAULT_TIMELINE_BOOKMARK_COLOR } from "@/timeline/components/theme";
import { DEFAULT_FPS } from "@/fps/defaults";
import { cn } from "@/utils/ui";
import { downloadBlob } from "@/utils/browser";
import { formatTimecode, type FrameRate } from "opencut-wasm";
import { type MediaTime, snapSeekMediaTime } from "@/wasm";
import type { Bookmark } from "@/timeline";
import { buildMarkersCsv } from "@/components/editor/panels/assets/markers-csv";

const MARKER_COLORS = [
	"#009dff",
	"#fb2c36",
	"#ff8904",
	"#ffb900",
	"#5DBAA0",
	"#8F5DBA",
	"#BA5D7A",
	"#ffffff",
] as const;

function formatMarkerTimecode({
	time,
	fps,
}: {
	time: MediaTime;
	fps: FrameRate;
}): string {
	return formatTimecode({ time, format: "HH:MM:SS:FF", rate: fps }) ?? "";
}

export function MarkersView() {
	const editor = useEditor();
	const bookmarks = useEditor((e) => e.scenes.getActiveScene().bookmarks);
	const fps = useEditor(
		(e) => e.project.getActiveOrNull()?.settings.fps ?? DEFAULT_FPS,
	);

	const sorted = useMemo(
		() => [...bookmarks].sort((a, b) => a.time - b.time),
		[bookmarks],
	);

	const handleSeek = ({ time }: { time: MediaTime }) => {
		const duration = editor.timeline.getTotalDuration();
		const snappedTime = snapSeekMediaTime({ time, duration, fps });
		editor.playback.seek({ time: snappedTime });
	};

	const handleRemove = ({ time }: { time: MediaTime }) => {
		void editor.scenes.removeBookmark({ time });
	};

	const handleUpdate = ({
		time,
		updates,
	}: {
		time: MediaTime;
		updates: Partial<Omit<Bookmark, "time">>;
	}) => {
		void editor.scenes.updateBookmark({ time, updates });
	};

	const handleExport = () => {
		const csv = buildMarkersCsv({
			markers: sorted.map((bookmark) => ({
				timecode: formatMarkerTimecode({ time: bookmark.time, fps }),
				comment: bookmark.note,
				color: bookmark.color,
			})),
		});
		const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
		downloadBlob({ blob, filename: "markers.csv" });
	};

	return (
		<PanelView
			title="Markers"
			actions={
				<Button
					type="button"
					variant="text"
					size="sm"
					className="text-muted-foreground hover:text-foreground gap-1.5"
					disabled={sorted.length === 0}
					onClick={handleExport}
					aria-label="Export markers to CSV"
				>
					<HugeiconsIcon icon={Download01Icon} className="!size-3.5" />
					Export CSV
				</Button>
			}
		>
			{sorted.length === 0 ? (
				<div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-sm">
					<HugeiconsIcon icon={Bookmark02Icon} className="size-6 opacity-50" />
					<p>No markers</p>
					<p className="text-xs">
						Press M on the timeline to add one at the playhead.
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-1 pb-2">
					{sorted.map((bookmark) => (
						<MarkerRow
							key={`marker-${bookmark.time}`}
							bookmark={bookmark}
							fps={fps}
							onSeek={handleSeek}
							onRemove={handleRemove}
							onUpdate={handleUpdate}
						/>
					))}
				</div>
			)}
		</PanelView>
	);
}

function MarkerRow({
	bookmark,
	fps,
	onSeek,
	onRemove,
	onUpdate,
}: {
	bookmark: Bookmark;
	fps: FrameRate;
	onSeek: (params: { time: MediaTime }) => void;
	onRemove: (params: { time: MediaTime }) => void;
	onUpdate: (params: {
		time: MediaTime;
		updates: Partial<Omit<Bookmark, "time">>;
	}) => void;
}) {
	const color = bookmark.color ?? DEFAULT_TIMELINE_BOOKMARK_COLOR;
	const timecode = formatMarkerTimecode({ time: bookmark.time, fps });
	const [draftComment, setDraftComment] = useState(bookmark.note ?? "");

	const commitComment = () => {
		const next = draftComment.trim();
		const current = bookmark.note ?? "";
		if (next === current) return;
		onUpdate({
			time: bookmark.time,
			updates: { note: next === "" ? undefined : next },
		});
	};

	const selectColor = ({ value }: { value: string }) => {
		if (value === (bookmark.color ?? "")) return;
		onUpdate({
			time: bookmark.time,
			updates: { color: value === "" ? undefined : value },
		});
	};

	return (
		<div className="hover:bg-accent group flex items-center gap-1.5 rounded-sm pr-1">
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						className="hover:border-foreground/40 shrink-0 rounded-[3px] border border-transparent p-1"
						aria-label={`Set color for marker at ${timecode}`}
					>
						<span
							className="size-2.5 rounded-[2px]"
							style={{ backgroundColor: color }}
						/>
					</button>
				</PopoverTrigger>
				<PopoverContent className="w-auto p-2" align="start">
					<div className="grid grid-cols-4 gap-1.5">
						{MARKER_COLORS.map((swatch) => (
							<button
								key={swatch}
								type="button"
								className={cn(
									"border-foreground/15 hover:border-primary size-6 cursor-pointer rounded-sm border",
									bookmark.color?.toLowerCase() === swatch.toLowerCase() &&
										"border-primary border-2",
								)}
								style={{ backgroundColor: swatch }}
								onClick={() => selectColor({ value: swatch })}
								aria-label={`Select color ${swatch}`}
							/>
						))}
					</div>
					{bookmark.color ? (
						<Button
							type="button"
							variant="text"
							size="sm"
							className="text-muted-foreground hover:text-foreground mt-2 w-full justify-center text-xs"
							onClick={() => selectColor({ value: "" })}
						>
							Clear color
						</Button>
					) : null}
				</PopoverContent>
			</Popover>
			<button
				type="button"
				className="bg-transparent text-left"
				onClick={() => onSeek({ time: bookmark.time })}
				aria-label={`Seek to marker at ${timecode}`}
			>
				<span className="text-foreground shrink-0 font-mono text-xs">
					{timecode}
				</span>
			</button>
			<Input
				value={draftComment}
				onChange={(event) => setDraftComment(event.target.value)}
				onBlur={commitComment}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.currentTarget.blur();
					} else if (event.key === "Escape") {
						setDraftComment(bookmark.note ?? "");
						event.currentTarget.blur();
					}
				}}
				placeholder="Add a comment"
				className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-xs focus-visible:bg-input/30"
				aria-label={`Comment for marker at ${timecode}`}
			/>
			<Button
				type="button"
				variant="text"
				size="icon"
				className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100"
				aria-label={`Delete marker at ${timecode}`}
				onClick={() => onRemove({ time: bookmark.time })}
			>
				<HugeiconsIcon icon={Delete02Icon} className="!size-3.5" />
			</Button>
		</div>
	);
}
