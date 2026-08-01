"use client";

/**
 * The Transcript tab: reads the current timeline's transcript as text so a word
 * range can be selected and ripple-deleted (U3/U4), and copied/exported (U5).
 * Fetching goes through the shared `ensureTimelineTranscript` cache (the SAME
 * call the background transcriber and the Director use), so opening this tab
 * never introduces a second transcription code path. A `wantWords: true` request
 * can still trigger a real word-level pass (multi-second on local Whisper) even
 * when a segment-only cache entry already exists, so progress is honest.
 *
 * T16.2 puts the TRANSCRIPT LINEAGE in charge whenever it can explain the live
 * timeline. The panel then reads its words, segments AND seams (the red pipes)
 * straight from `readTranscriptLineage`, so a delete needs no local strikethrough
 * preview and no timestamp remap: the cut words move from the word flow to a
 * pipe, which is both truer and restorable per word. The pre-T16.1 local preview
 * (`removedIndices` + `remapTranscriptTimestamps` + the "showing a local preview"
 * banner) is kept ONLY as the fallback for a "missing"/"cannot-explain" lineage -
 * a fresh project before its first capture, or an edit the journal cannot account
 * for - where it is still the best the panel can do.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { Gps01Icon, MoreVerticalIcon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/editor/use-editor";
import type { Command } from "@/commands/base-command";
import { cn } from "@/utils/ui";
import { useLocalStorage } from "@/services/storage/use-local-storage";
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
import {
	countTranscriptWords,
	deriveTranscriptReadyState,
} from "@/features/transcription/transcript-ready-state";
import { canRestoreDeletion } from "@/features/transcription/restore-popover-gate";
import { readTranscriptLineage } from "@/features/transcription/lineage";
import type { LineageSeam } from "@/features/transcription/lineage-types";
import {
	deriveSeamMarkers,
	groupSeamMarkers,
} from "@/features/transcription/seam-markers";
import { describeSeam } from "@/features/transcription/seam-window-model";
import { restoreSeamWords } from "@/features/transcription/restore-seam";
import { downloadBuffer } from "@/export";
import { mediaTimeFromSeconds, mediaTimeToSeconds, type MediaTime } from "@/wasm";
import { TranscriptText } from "./transcript-text";
import {
	TranscriptRestorePopover,
	type RestoreAnchorRect,
	type SeamWordRange,
} from "./transcript-restore-popover";

/** One manual deletion, tracked for the restore-popover shell (T16.3). The
 * `command` is captured right after `editor.command.execute(...)` returns -
 * it is the SAME object identity `peekUndoCommand()` returns while this
 * delete is still the top of the undo stack, which is exactly what
 * `canRestoreDeletion` compares. */
interface DeletionRecord {
	id: number;
	startIndex: number;
	endIndex: number;
	command: Command | null;
}

interface ActivePopover {
	deletion: DeletionRecord;
	anchorRect: RestoreAnchorRect;
}

/** T16.2: the open red-pipe window (the lineage path's popover). */
interface ActiveSeamPopover {
	seamId: string;
	anchorRect: RestoreAnchorRect;
}

const FOLLOW_PLAYBACK_STORAGE_KEY = "vibecut-transcript-follow-playback";

type LoadState =
	| { status: "loading"; detail: string; progress?: number }
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
	// T16.3: one manual deletion is a click target for the restore popover
	// shell as long as its struck words are still in `removedIndices`.
	const [deletionRecords, setDeletionRecords] = useState<DeletionRecord[]>([]);
	const [activePopover, setActivePopover] = useState<ActivePopover | null>(
		null,
	);
	const deletionIdRef = useRef(0);
	// T16.2: the red pipes, plus which one is open / hovered. `lineageExplained`
	// is the switch between the lineage path and the pre-T16.1 local preview.
	const [seams, setSeams] = useState<LineageSeam[]>([]);
	const [lineageExplained, setLineageExplained] = useState(false);
	const [activeSeam, setActiveSeam] = useState<ActiveSeamPopover | null>(null);
	const [hoveredSeamId, setHoveredSeamId] = useState<string | null>(null);
	// T16.3: auto-scroll-follow, default ON, persisted across sessions.
	const [followEnabled, setFollowEnabled] = useLocalStorage({
		key: FOLLOW_PLAYBACK_STORAGE_KEY,
		defaultValue: true,
	});

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
		// T16.1 note 2: with a lineage in charge the displayed coordinates are
		// re-derived from the live timeline on every edit, so the stale-coordinate
		// guard has nothing to protect against and must not block further deletes.
		lineageExplained,
	});

	// T16.2: adopt the lineage as the panel's source of truth whenever it explains
	// the live timeline. Returns false when it cannot, which leaves the caller on
	// the pre-T16.1 local-preview path.
	const syncFromLineage = useCallback(
		({
			currentWords,
		}: {
			currentWords: readonly TranscriptWordLite[];
		}): boolean => {
			const view = readTranscriptLineage({ editor });
			if (view.status !== "explained") {
				setSeams([]);
				setLineageExplained(false);
				return false;
			}
			// Word-level pipes are placed by INDEX into the lineage's own word array,
			// so they may only be drawn when that array is what is on screen. The one
			// case where it is not is a words-less capture next to a word-level
			// transcript (a degraded model, then a later word upgrade): keep the words
			// and drop the pipes rather than misplace them.
			const takeWords = view.words.length > 0;
			if (takeWords) setWords(view.words);
			if (view.segments.length > 0) setSegments(view.segments);
			setSeams(takeWords || currentWords.length === 0 ? view.seams : []);
			setLineageExplained(true);
			setSelection(null);
			setRemovedIndices(new Set());
			setDeletionRecords([]);
			setActivePopover(null);
			setStale(false);
			setExpectedHash(safeAudioHash(editor));
			return true;
		},
		[editor],
	);

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
					setLoad({ status: "loading", detail: p.detail, progress: p.progress });
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
				setDeletionRecords([]);
				setActivePopover(null);
				setActiveSeam(null);
				setStale(false);
				setExpectedHash(safeAudioHash(editor));
				// A fresh transcription resets the lineage to this very capture, so
				// this normally lands on an empty journal (no pipes). It matters when
				// the transcript came from the lineage FAST PATH instead: the seams
				// are then already there and must be drawn on the first render.
				syncFromLineage({ currentWords: result.words ?? [] });
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
	}, [editor, syncFromLineage]);

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

	// T16.2: an external edit, an undo or a redo moves the timeline hash. Re-read
	// the lineage so the pipes (and the words around them) follow the live timeline
	// instead of waiting for a manual Refresh - that is what makes one Ctrl+Z after
	// a restore put the pipe straight back. Cheap: pure derivation over a stored
	// record, and `liveHash` only moves on a real tracks change. The words go
	// through a ref so re-reading never re-triggers this effect.
	const wordsRef = useRef<readonly TranscriptWordLite[]>([]);
	useEffect(() => {
		wordsRef.current = words;
	}, [words]);
	useEffect(() => {
		if (load.status !== "ready") return;
		syncFromLineage({ currentWords: wordsRef.current });
	}, [liveHash, load.status, syncFromLineage]);

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
		// T16.2 (roadmap note 1): with a lineage in charge the deleted words become a
		// red pipe on the next read, so none of the local strikethrough preview below
		// runs - no `removedIndices`, no timestamp remap, no "local preview" banner.
		if (syncFromLineage({ currentWords: words })) return;
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
		// T16.3 restore shell: capture the command `deleteTranscriptSelection` just
		// pushed. `execute()` runs synchronously, so it is now the top of the undo
		// stack - `peekUndoCommand()` returns THIS delete's own command identity.
		deletionIdRef.current += 1;
		setDeletionRecords((prev) => [
			...prev,
			{
				id: deletionIdRef.current,
				startIndex: selection.startIndex,
				endIndex: selection.endIndex,
				command: editor.command.peekUndoCommand(),
			},
		]);
	}, [selection, timelineChanged, editor, words, segments, syncFromLineage]);

	// T16.2: a red pipe was clicked - open its window, anchored on the pipe.
	const handleSeamClick = useCallback(
		({ seamId, rect }: { seamId: string; rect: DOMRect | null }) => {
			if (!rect) return;
			setActivePopover(null);
			setActiveSeam({
				seamId,
				anchorRect: { top: rect.top, left: rect.left, bottom: rect.bottom },
			});
		},
		[],
	);

	const handleCloseSeam = useCallback(() => setActiveSeam(null), []);

	// T16.2: restore all of a seam, or the sub-range selected in its window, as
	// ONE undoable command; then re-read the lineage so the pipe disappears (full
	// restore) or shrinks to what is still cut (partial).
	const handleSeamRestore = useCallback(
		(range?: SeamWordRange) => {
			const seam = seams.find((candidate) => candidate.id === activeSeam?.seamId);
			if (!seam) return;
			restoreSeamWords({
				editor,
				seam,
				wordStartIndex: range?.startIndex,
				wordEndIndex: range?.endIndex,
			});
			setActiveSeam(null);
			syncFromLineage({ currentWords: words });
		},
		[activeSeam, seams, editor, words, syncFromLineage],
	);

	// T16.3: a struck word range was clicked - find the deletion that produced
	// it (indices are stable across remaps, only timestamps shift) and open
	// the restore popover shell anchored at the clicked span.
	const handleRemovedClick = useCallback(
		({ index, rect }: { index: number; rect: DOMRect | null }) => {
			const deletion = [...deletionRecords]
				.reverse()
				.find((d) => index >= d.startIndex && index <= d.endIndex);
			if (!deletion || !rect) return;
			setActivePopover({
				deletion,
				anchorRect: { top: rect.top, left: rect.left, bottom: rect.bottom },
			});
		},
		[deletionRecords],
	);

	const handleClosePopover = useCallback(() => {
		setActivePopover(null);
		setActiveSeam(null);
	}, []);

	// Only ever runs when `canRestoreDeletion` already confirmed this delete is
	// still the top of the undo stack (see the popover's own gating below), so
	// this is the ONLY local edit outstanding - undo, then reload the transcript
	// from the now-restored live timeline instead of trying to un-shift the
	// local preview's remapped coordinates in place.
	const handleRestore = useCallback(() => {
		if (!activePopover) return;
		editor.command.undo();
		setActivePopover(null);
		loadTranscript();
	}, [activePopover, editor, loadTranscript]);

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

	// T16.3: the header's ambient status - see transcript-ready-state.ts.
	const wordCount = countTranscriptWords({ granularity, words, segments });
	const readyState = deriveTranscriptReadyState({
		loadStatus: load.status,
		progressPercent: load.status === "loading" ? (load.progress ?? null) : null,
		wordCount,
		stale,
		timelineChanged,
	});
	const readyStatusClassName = cn(
		"min-w-0 truncate text-xs",
		readyState.tone === "error" && "text-destructive",
		readyState.tone === "stale" &&
			(timelineChanged
				? "text-destructive"
				: "text-amber-600 dark:text-amber-400"),
		(readyState.tone === "ready" ||
			readyState.tone === "transcribing" ||
			readyState.tone === "idle") &&
			"text-muted-foreground",
	);

	// T16.3: re-checked at RENDER time (not baked in at click time) so the
	// popover always reflects whether a plain undo would still hit this exact
	// delete, even if the undo stack changed while the popover sat open.
	const activePopoverCanRestore = activePopover
		? canRestoreDeletion({
				deletionCommand: activePopover.deletion.command,
				topUndoCommand: editor.command.peekUndoCommand(),
			})
		: false;

	// T16.2: where the red pipes go, and what the open window renders. Both come
	// from pure helpers, so this is just memoized derivation.
	const seamsByIndex = useMemo(
		() => groupSeamMarkers(deriveSeamMarkers({ seams, items, granularity })),
		[seams, items, granularity],
	);
	const activeSeamModel = useMemo(() => {
		const seam = seams.find((candidate) => candidate.id === activeSeam?.seamId);
		return seam ? describeSeam({ seam }) : null;
	}, [seams, activeSeam]);

	return (
		<PanelView
			title="Transcript"
			contentClassName="px-0 flex flex-col h-full"
			actions={
				<div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
					<span className={readyStatusClassName} title={readyState.label}>
						{readyState.label}
					</span>
					{load.status === "ready" && (
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon"
										variant={followEnabled ? "secondary" : "text"}
										aria-label="Follow playback"
										aria-pressed={followEnabled}
										onClick={() =>
											setFollowEnabled({ value: (prev) => !prev })
										}
									>
										<HugeiconsIcon icon={Gps01Icon} size={16} />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Follow playback</TooltipContent>
							</Tooltip>
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
						</>
					)}
				</div>
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
						followEnabled={followEnabled}
						onRemovedClick={handleRemovedClick}
						onScroll={handleClosePopover}
						seamsByIndex={seamsByIndex}
						activeSeamId={activeSeam?.seamId ?? null}
						hoveredSeamId={hoveredSeamId}
						onSeamClick={handleSeamClick}
						onSeamHover={setHoveredSeamId}
					/>
				</div>
			)}
			{activeSeam && activeSeamModel && (
				<TranscriptRestorePopover
					// Remount per seam: the card owns its word selection, and a stale
					// range from the previous pipe must never carry over.
					key={activeSeam.seamId}
					target={{ kind: "seam", ...activeSeamModel }}
					anchorRect={activeSeam.anchorRect}
					onRestore={() => handleSeamRestore()}
					onRestoreWords={handleSeamRestore}
					onClose={handleCloseSeam}
				/>
			)}
			{activePopover && (
				<TranscriptRestorePopover
					key={`deletion-${activePopover.deletion.id}`}
					target={{
						kind: "deletion",
						startIndex: activePopover.deletion.startIndex,
						endIndex: activePopover.deletion.endIndex,
						words: items
							.slice(
								activePopover.deletion.startIndex,
								activePopover.deletion.endIndex + 1,
							)
							.map((item) => item.text),
						canRestore: activePopoverCanRestore,
					}}
					anchorRect={activePopover.anchorRect}
					onRestore={handleRestore}
					onClose={handleClosePopover}
				/>
			)}
		</PanelView>
	);
}
