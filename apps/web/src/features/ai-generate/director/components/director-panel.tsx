"use client";

/**
 * The auto-assemble REVIEW panel (right inspector). Renders the editable rough-cut
 * draft: each kept span shows its ORIGINAL source timecode AND its floating
 * current position on the assembled timeline; rows play on click and can be
 * dropped, re-included, or swapped to another take. Each edit re-projects the main
 * track (one undoable command), so Ctrl+Z steps back through the changes.
 */

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditor } from "@/editor/use-editor";
import { mediaTimeFromSeconds } from "@/wasm";
import { useDirectorPlanStore } from "../director-plan-store";
import {
	dropSpan,
	includeSpan,
	placedSpans,
	swapSpan,
	type DraftSpan,
	type SpanAlternate,
} from "../assembly-draft";
import { reprojectAssembly } from "../run-assemble";
import { formatTimecode, formatTimeRange } from "../review-format";

export function DirectorPanel() {
	const editor = useEditor();
	const draft = useDirectorPlanStore((s) => s.draft);
	const applyDraftEdit = useDirectorPlanStore((s) => s.applyDraftEdit);
	const closeAssemble = useDirectorPlanStore((s) => s.closeAssemble);

	if (!draft) return null;

	const placed = placedSpans(draft.spans);
	const dropped = draft.spans.filter((span) => span.dropped);
	const totalSec = placed.reduce(
		(acc, span) => acc + (span.currentEndSec - span.currentStartSec),
		0,
	);

	const edit = (nextSpans: DraftSpan[]) => {
		applyDraftEdit(nextSpans);
		reprojectAssembly({ editor, spans: nextSpans });
	};
	const playAt = (currentStartSec: number) => {
		editor.playback.seek({
			time: mediaTimeFromSeconds({ seconds: currentStartSec }),
		});
		editor.playback.play();
	};

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			<div className="border-b p-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">Director&apos;s cut</h2>
					<Button variant="ghost" size="sm" onClick={closeAssemble}>
						Done
					</Button>
				</div>
				<p className="text-muted-foreground text-xs">
					{placed.length} clip{placed.length === 1 ? "" : "s"} ·{" "}
					{formatTimecode(totalSec)} — click a row to play it. Drop, re-include,
					or swap takes; Ctrl+Z reverts.
				</p>
			</div>

			<div className="flex-1 space-y-1 overflow-y-auto p-2">
				{placed.map((span) => {
					const alternates = span.clusterId
						? (draft.alternatesByClusterId[span.clusterId] ?? [])
						: [];
					return (
						<div
							key={span.id}
							className="hover:bg-accent/40 rounded-sm border p-2 text-sm"
						>
							<button
								type="button"
								className="flex w-full items-start gap-2 text-left"
								onClick={() => playAt(span.currentStartSec)}
							>
								<span className="text-foreground min-w-0 flex-1">
									<span className="text-muted-foreground mr-2 font-mono text-xs">
										{formatTimeRange({
											startSec: span.currentStartSec,
											endSec: span.currentEndSec,
										})}
									</span>
									{span.text ? (
										<>&ldquo;{span.text.trim().slice(0, 90)}&rdquo;</>
									) : (
										span.clipName
									)}
									<span className="text-muted-foreground mt-0.5 block text-xs">
										{span.clipName} · src{" "}
										{formatTimeRange({
											startSec: span.sourceStartSec,
											endSec: span.sourceEndSec,
										})}
									</span>
								</span>
							</button>

							<div className="mt-1.5 flex gap-1">
								<Button
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-xs"
									onClick={() => playAt(span.currentStartSec)}
								>
									Play
								</Button>
								<Button
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-xs"
									onClick={() => edit(dropSpan({ spans: draft.spans, id: span.id }))}
								>
									Drop
								</Button>
								{alternates.length > 1 ? (
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												className="h-6 px-2 text-xs"
											>
												Swap take ({alternates.length})
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="start" className="max-w-sm">
											{alternates.map((alternate: SpanAlternate) => (
												<DropdownMenuItem
													key={`${alternate.assetId}-${alternate.sourceStartSec}`}
													onClick={() =>
														edit(
															swapSpan({
																spans: draft.spans,
																id: span.id,
																alternate,
															}),
														)
													}
												>
													<span className="truncate text-xs">
														{alternate.clipName} ·{" "}
														{formatTimeRange({
															startSec: alternate.sourceStartSec,
															endSec: alternate.sourceEndSec,
														})}
														{alternate.text
															? ` — "${alternate.text.trim().slice(0, 40)}"`
															: ""}
													</span>
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								) : null}
							</div>
						</div>
					);
				})}

				{dropped.length > 0 ? (
					<div className="mt-2 space-y-1">
						<p className="text-muted-foreground px-1 text-xs font-medium">
							Dropped ({dropped.length})
						</p>
						{dropped.map((span) => (
							<div
								key={span.id}
								className="flex items-center justify-between gap-2 rounded-sm border border-dashed p-2 text-sm"
							>
								<span className="text-muted-foreground min-w-0 flex-1 truncate line-through">
									{span.text ? span.text.trim().slice(0, 70) : span.clipName}
								</span>
								<Button
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-xs"
									onClick={() =>
										edit(includeSpan({ spans: draft.spans, id: span.id }))
									}
								>
									Re-include
								</Button>
							</div>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
