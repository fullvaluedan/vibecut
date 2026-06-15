"use client";

import { useMemo } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Bookmark02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { DEFAULT_TIMELINE_BOOKMARK_COLOR } from "@/timeline/components/theme";
import { DEFAULT_FPS } from "@/fps/defaults";
import { cn } from "@/utils/ui";
import { formatTimecode, type FrameRate } from "opencut-wasm";
import { type MediaTime, snapSeekMediaTime } from "@/wasm";
import type { Bookmark } from "@/timeline";

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
		editor.scenes.removeBookmark({ time });
	};

	return (
		<PanelView title="Markers">
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
}: {
	bookmark: Bookmark;
	fps: FrameRate;
	onSeek: (params: { time: MediaTime }) => void;
	onRemove: (params: { time: MediaTime }) => void;
}) {
	const color = bookmark.color ?? DEFAULT_TIMELINE_BOOKMARK_COLOR;
	const timecode = formatTimecode({
		time: bookmark.time,
		format: "HH:MM:SS:FF",
		rate: fps,
	});

	return (
		<div className="hover:bg-accent group flex items-center gap-2 rounded-sm pr-1">
			<button
				type="button"
				className={cn(
					"flex min-w-0 flex-1 items-center gap-2 rounded-sm bg-transparent px-2 py-1.5 text-left",
				)}
				onClick={() => onSeek({ time: bookmark.time })}
				aria-label={`Seek to marker at ${timecode}`}
			>
				<span
					className="size-2.5 shrink-0 rounded-[2px]"
					style={{ backgroundColor: color }}
				/>
				<span className="text-foreground shrink-0 font-mono text-xs">
					{timecode}
				</span>
				{bookmark.note ? (
					<span className="text-muted-foreground truncate text-xs">
						{bookmark.note}
					</span>
				) : null}
			</button>
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
