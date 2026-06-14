"use client";

/**
 * The "terminal" toggle next to RUN HYPERFRAMES. Opens a live, auto-scrolling
 * log so the user can see the run IS moving even on a slow stage (model
 * download, audio decode), and read what happened if it fails.
 */

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverTrigger,
	PopoverContent,
} from "@/components/ui/popover";
import { useRunLogStore } from "@/features/ai-generate/run-log-store";
import { cn } from "@/utils/ui";

function fmtTime(t: number): string {
	const d = new Date(t);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function RunLogPanel() {
	const lines = useRunLogStore((s) => s.lines);
	const open = useRunLogStore((s) => s.open);
	const setOpen = useRunLogStore((s) => s.setOpen);
	const clear = useRunLogStore((s) => s.clear);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Stick to the bottom as new lines arrive.
	useEffect(() => {
		const el = scrollRef.current;
		if (el && open) el.scrollTop = el.scrollHeight;
	}, [lines, open]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground rounded-sm px-2 text-xs"
					title="Show the HyperFrames run log"
				>
					Log{lines.length ? ` (${lines.length})` : ""}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-96 p-0">
				<div className="flex items-center justify-between border-b px-3 py-1.5">
					<span className="text-xs font-semibold">Run log</span>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 rounded-sm px-2 text-xs"
						onClick={clear}
					>
						Clear
					</Button>
				</div>
				<div
					ref={scrollRef}
					className="max-h-72 overflow-y-auto bg-black/90 p-2 font-mono text-[11px] leading-relaxed text-green-300/90"
				>
					{lines.length === 0 ? (
						<p className="text-muted-foreground">
							No activity yet. Run HyperFrames to see live progress here.
						</p>
					) : (
						lines.map((l) => (
							<div
								key={l.id}
								className={cn(
									"break-words whitespace-pre-wrap",
									l.level === "error" && "text-red-400",
									l.level === "warn" && "text-yellow-300",
								)}
							>
								<span className="text-white/40">{fmtTime(l.t)} </span>
								{l.text}
							</div>
						))
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
