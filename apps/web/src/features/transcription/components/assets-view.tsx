"use client";

/**
 * The Transcript tab: reads the current timeline's transcript as text so a word
 * range can be selected and ripple-deleted (U3/U4), and copied/exported (U5).
 * Fetching goes through the shared `ensureTimelineTranscript` cache (the SAME
 * call the background transcriber and the Director use), so opening this tab
 * never introduces a second transcription code path. A `wantWords: true` request
 * can still trigger a real word-level pass (multi-second on local Whisper) even
 * when a segment-only cache entry already exists, so progress is honest.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreVerticalIcon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/editor/use-editor";
import {
	computeTimelineAudioHash,
	ensureTimelineTranscript,
	type TranscriptSegmentLite,
	type TranscriptWordLite,
} from "@/features/transcription/transcript-cache";
import { timelineChangedWhileStale } from "@/features/transcription/detect-timeline-change";
import { classifyTranscriptLoadError } from "@/features/transcription/transcript-load-error";
import type {
	TranscriptGranularity,
	TranscriptSelection,
} from "@/features/transcription/resolve-selection-to-range";
import { deleteTranscriptSelection } from "@/features/transcription/delete-transcript-selection";
import { remapTranscriptTimestamps } from "@/features/transcription/remap-transcript-timestamps";
import { formatTranscriptText } from "@/features/transcription/format-transcript-text";
import {
	formatTranscriptCsv,
	formatTranscriptSrt,
	formatTranscriptTxt,
} from "@/features/transcription/export-transcript";
import { findActiveTranscriptIndex } from "@/features/transcription/find-active-transcript-index";
import { downloadBuffer } from "@/export";
import { mediaTimeFromSeconds, mediaTimeToSeconds, type MediaTime } from "@/wasm";
import { TranscriptText } from "./transcript-text";

type LoadState =
	| { status: "loading"; detail: string }
	| { status: "ready" }
	| { status: "empty" }
	| { status: "error"; message: string };

/** The timeline audio hash, or "" if it can't be read (never blocks on its own). */
function safeAudioHash(editor: Parameters<typeof computeTimelineAudioHash>[0]): string {
	try {
		return computeTimelineAudioHash(editor);
	} catch {
		return "";
	}
}

/** Shared by the Export kebab's three formats (W4/R1) - format, then download. */
function downloadText({
	text,
	filename,
	mimeType,
}: {
	text: string;
	filename: string;
	mimeType: string;
}): void {
	downloadBuffer({
		buffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
		filename,
		mimeType,
	});
}

export function TranscriptView() {
	const editor = useEditor();
	const [load, setLoad] = useState<LoadState>({
		status: "loading",
		detail: "Reading transcript...",
	});
	const [segments, setSegments] = useState<TranscriptSegmentLite[]>([]);
	const [words, setWords] = useState<TranscriptWordLite[]>([]);
	const [selection, setSelection] = useState<TranscriptSelection | null>(null);
	// Display indices struck as optimistically removed since the last refresh.
	const [removedIndices, setRemovedIndices] = useState<ReadonlySet<number>>(
		new Set(),
	);
	const [stale, setStale] = useState(false);
	const [copied, setCopied] = useState(false);
	// W4/R1: TXT export toggle (speakers omitted - TranscriptionResult has no
	// speaker labels, so there is nothing to toggle there).
	const [includeTimecodes, setIncludeTimecodes] = useState(true);
	// W4/R3: live search text - highlights/dims in TranscriptText, never filters
	// the underlying items array (that would break ripple-delete's index math).
	const [searchQuery, setSearchQuery] = useState("");
	// W4/R2: the word/segment playing right now, from the live playhead.
	const [activeIndex, setActiveIndex] = useState<number | null>(null);

	const abortRef = useRef<AbortController | null>(null);
	// Ignore responses from a superseded load (mount race or manual refresh).
	const genRef = useRef(0);
	// The timeline audio hash captured right after our last load/delete. While
	// stale, a live hash that no longer matches means the timeline moved out from
	// under our local coords (undo/redo/manual edit) and deletes must be blocked.
	const [expectedHash, setExpectedHash] = useState("");

	// Recompute the live hash only when the tracks reference actually changes (a
	// real edit, undo, or redo replaces it), the same cheap selector the background
	// transcriber uses, so scrubbing/selection never triggers it.
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const liveHash = useMemo(() => {
		if (!tracks) return "";
		try {
			return computeTimelineAudioHash(editor);
		} catch {
			return "";
		}
	}, [tracks, editor]);
	const timelineChanged = timelineChangedWhileStale({
		stale,
		liveHash,
		expectedHash,
	});

	// Word-level when the model produced words; otherwise segment-level (KTD4).
	const granularity: TranscriptGranularity =
		words.length > 0 ? "word" : "segment";
	const items = granularity === "word" ? words : segments;

	const loadTranscript = useCallback(() => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		const gen = ++genRef.current;
		setLoad({ status: "loading", detail: "Reading transcript..." });
		ensureTimelineTranscript({
			editor,
			wantWords: true,
			signal: controller.signal,
			onProgress: (p) => {
				if (gen === genRef.current) {
					setLoad({ status: "loading", detail: p.detail });
				}
			},
		})
			.then((result) => {
				if (gen !== genRef.current) return;
				if (result.segments.length === 0) {
					setLoad({ status: "empty" });
					return;
				}
				setSegments(result.segments);
				setWords(result.words ?? []);
				setSelection(null);
				setRemovedIndices(new Set());
				setStale(false);
				setExpectedHash(safeAudioHash(editor));
				setLoad({ status: "ready" });
			})
			.catch((err: unknown) => {
				if (gen !== genRef.current) return;
				const message = err instanceof Error ? err.message : String(err);
				// Swallow ONLY a cancel we initiated (our unmount, or a newer load that
				// aborted this controller). A cancel from a joined run someone else
				// aborted must not leave the panel stuck on the spinner.
				const kind = classifyTranscriptLoadError({
					message,
					ownAbort: controller.signal.aborted,
				});
				if (kind === "ignore") return;
				if (kind === "empty") {
					setLoad({ status: "empty" });
					return;
				}
				setLoad({
					status: "error",
					message: /cancel/i.test(message)
						? "Transcription was interrupted. Click Try again."
						: message,
				});
			});
	}, [editor]);

	useEffect(() => {
		// Kick off the load (and its progress state) when the tab opens; the
		// generation guard makes a superseded load's setState a no-op.
		// eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open, not derived state.
		loadTranscript();
		return () => abortRef.current?.abort();
	}, [loadTranscript]);

	// W4/R2: highlight the word/segment playing right now. Subscribes to BOTH
	// playback updates (during play) and seeks (scrub/click-a-word/undo), same
	// pair use-timeline-playhead.ts subscribes to for the ruler. Re-renders
	// only when the ACTIVE INDEX changes (not every animation frame), and the
	// binary search in findActiveTranscriptIndex keeps each check cheap even on
	// a long, word-level transcript.
	const activeIndexRef = useRef<number | null>(null);
	useEffect(() => {
		const update = (time: MediaTime) => {
			const timeSec = mediaTimeToSeconds({ time });
			const next = findActiveTranscriptIndex({ items, timeSec });
			if (next !== activeIndexRef.current) {
				activeIndexRef.current = next;
				setActiveIndex(next);
			}
		};
		update(editor.playback.getCurrentTime());
		const unsubscribeUpdate = editor.playback.onUpdate(update);
		const unsubscribeSeek = editor.playback.onSeek(update);
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
		};
	}, [editor, items]);

	// W4/R2: click-a-word seeks the playhead.
	const handleSeek = useCallback(
		(seconds: number) => {
			editor.playback.seek({ time: mediaTimeFromSeconds({ seconds }) });
		},
		[editor],
	);

	const handleDelete = useCallback(() => {
		// Blocked while the timeline has moved under us (undo/redo/manual edit);
		// the user must Refresh so the local coords match the live timeline again.
		if (!selection || timelineChanged) return;
		const range = deleteTranscriptSelection({
			editor,
			selection,
			words,
			segments,
		});
		if (!range) return;
		const removedDurationSec = range.endSec - range.startSec;
		// Strike the deleted display items (indices into `items`).
		setRemovedIndices((prev) => {
			const next = new Set(prev);
			for (let i = selection.startIndex; i <= selection.endIndex; i++) {
				next.add(i);
			}
			return next;
		});
		// Shift the remaining words AND segments left, mirroring the live ripple
		// (KTD5), so the NEXT delete resolves against the already-shifted coords.
		setWords((prev) =>
			remapTranscriptTimestamps({
				items: prev,
				deletedEndSec: range.endSec,
				removedDurationSec,
			}),
		);
		setSegments((prev) =>
			remapTranscriptTimestamps({
				items: prev,
				deletedEndSec: range.endSec,
				removedDurationSec,
			}),
		);
		setSelection(null);
		setStale(true);
		// The delete just changed the timeline; capture the new hash as the baseline
		// so this delete is not itself flagged as an external change.
		setExpectedHash(safeAudioHash(editor));
	}, [selection, timelineChanged, editor, words, segments]);

	const handleCopy = useCallback(() => {
		void navigator.clipboard
			.writeText(formatTranscriptText({ segments }))
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			});
	}, [segments]);

	// W4/R1: the Export kebab's three formats. Each just formats + downloads;
	// the actual serializers live in export-transcript.ts (pure, unit tested)
	// and subtitles/srt.ts (the shared SRT writer).
	const handleExportTxt = useCallback(() => {
		downloadText({
			text: formatTranscriptTxt({ segments, includeTimecodes }),
			filename: "transcript.txt",
			mimeType: "text/plain",
		});
	}, [segments, includeTimecodes]);

	const handleExportSrt = useCallback(() => {
		downloadText({
			text: formatTranscriptSrt({ segments }),
			filename: "transcript.srt",
			mimeType: "application/x-subrip",
		});
	}, [segments]);

	const handleExportCsv = useCallback(() => {
		downloadText({
			text: formatTranscriptCsv({ segments }),
			filename: "transcript.csv",
			mimeType: "text/csv",
		});
	}, [segments]);

	return (
		<PanelView
			title="Transcript"
			contentClassName="px-0 flex flex-col h-full"
			actions={
				load.status === "ready" && (
					<div className="flex items-center gap-1.5">
						<Button
							type="button"
							size="sm"
							variant="text"
							disabled={segments.length === 0}
							onClick={handleCopy}
						>
							{copied ? "Copied!" : "Copy"}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									size="icon"
									variant="text"
									disabled={segments.length === 0}
									aria-label="Export transcript"
									title="Export transcript"
								>
									<HugeiconsIcon icon={MoreVerticalIcon} size={16} />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuSub>
									<DropdownMenuSubTrigger>
										Export as .txt
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										<DropdownMenuCheckboxItem
											checked={includeTimecodes}
											onCheckedChange={setIncludeTimecodes}
										>
											Include timecodes
										</DropdownMenuCheckboxItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem onClick={handleExportTxt}>
											Download .txt
										</DropdownMenuItem>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								<DropdownMenuItem onClick={handleExportSrt}>
									Export as .srt
								</DropdownMenuItem>
								<DropdownMenuItem onClick={handleExportCsv}>
									Export as .csv
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!selection || timelineChanged}
							onClick={handleDelete}
							title={
								timelineChanged
									? "The timeline changed. Refresh the transcript before deleting."
									: "Delete the selected words from the timeline (Ctrl+Z to undo)"
							}
						>
							Delete
						</Button>
					</div>
				)
			}
		>
			{load.status === "loading" && (
				<div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
					<Spinner />
					{load.detail}
				</div>
			)}
			{load.status === "empty" && (
				<div className="text-muted-foreground p-4 text-sm">
					No speech found on the timeline yet. Add a clip with audio, then
					reopen this tab.
				</div>
			)}
			{load.status === "error" && (
				<div className="flex flex-col gap-2 p-4">
					<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
						<p className="text-destructive text-sm">{load.message}</p>
					</div>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="self-start"
						onClick={loadTranscript}
					>
						Try again
					</Button>
				</div>
			)}
			{load.status === "ready" && (
				<div className="flex h-full flex-col">
					<div className="border-b px-4 py-2">
						<Input
							size="sm"
							placeholder="Search transcript"
							value={searchQuery}
							onChange={({ currentTarget }) =>
								setSearchQuery(currentTarget.value)
							}
							showClearIcon
							onClear={() => setSearchQuery("")}
						/>
					</div>
					{stale && (
						<div
							className={
								timelineChanged
									? "text-destructive flex items-center justify-between gap-2 border-b bg-destructive/10 px-4 py-2 text-xs font-medium"
									: "text-muted-foreground flex items-center justify-between gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs"
							}
						>
							<span>
								{timelineChanged
									? "Timeline changed - refresh before deleting."
									: "Showing a local preview after your edits."}
							</span>
							<Button
								type="button"
								size="sm"
								variant="text"
								onClick={loadTranscript}
							>
								Refresh transcript
							</Button>
						</div>
					)}
					<TranscriptText
						items={items}
						granularity={granularity}
						selection={selection}
						onSelectionChange={setSelection}
						onDeleteSelection={handleDelete}
						removedIndices={removedIndices}
						onSeek={handleSeek}
						activeIndex={activeIndex}
						query={searchQuery}
					/>
				</div>
			)}
		</PanelView>
	);
}
