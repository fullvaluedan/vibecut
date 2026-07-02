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

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import {
	ensureTimelineTranscript,
	type TranscriptSegmentLite,
	type TranscriptWordLite,
} from "@/features/transcription/transcript-cache";
import type {
	TranscriptGranularity,
	TranscriptSelection,
} from "@/features/transcription/resolve-selection-to-range";
import { deleteTranscriptSelection } from "@/features/transcription/delete-transcript-selection";
import { remapTranscriptTimestamps } from "@/features/transcription/remap-transcript-timestamps";
import { formatTranscriptText } from "@/features/transcription/format-transcript-text";
import { downloadBuffer } from "@/export";
import { TranscriptText } from "./transcript-text";

type LoadState =
	| { status: "loading"; detail: string }
	| { status: "ready" }
	| { status: "empty" }
	| { status: "error"; message: string };

/** An "Add some footage..." throw means the timeline has no audio, not a failure. */
function isNoAudioError(message: string): boolean {
	return /footage|no speech|no audio/i.test(message);
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

	const abortRef = useRef<AbortController | null>(null);
	// Ignore responses from a superseded load (mount race or manual refresh).
	const genRef = useRef(0);

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
				setLoad({ status: "ready" });
			})
			.catch((err: unknown) => {
				if (gen !== genRef.current) return;
				const message = err instanceof Error ? err.message : String(err);
				if (/cancel/i.test(message)) return;
				setLoad(
					isNoAudioError(message)
						? { status: "empty" }
						: { status: "error", message },
				);
			});
	}, [editor]);

	useEffect(() => {
		// Kick off the load (and its progress state) when the tab opens; the
		// generation guard makes a superseded load's setState a no-op.
		// eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open, not derived state.
		loadTranscript();
		return () => abortRef.current?.abort();
	}, [loadTranscript]);

	const handleDelete = useCallback(() => {
		if (!selection) return;
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
	}, [selection, editor, words, segments]);

	const handleCopy = useCallback(() => {
		void navigator.clipboard
			.writeText(formatTranscriptText({ segments }))
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			});
	}, [segments]);

	const handleExport = useCallback(() => {
		const text = formatTranscriptText({ segments });
		downloadBuffer({
			buffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
			filename: "transcript.txt",
			mimeType: "text/plain",
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
						<Button
							type="button"
							size="sm"
							variant="text"
							disabled={segments.length === 0}
							onClick={handleExport}
						>
							Export
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!selection}
							onClick={handleDelete}
							title="Delete the selected words from the timeline (Ctrl+Z to undo)"
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
					{stale && (
						<div className="text-muted-foreground flex items-center justify-between gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs">
							<span>Showing a local preview after your edits.</span>
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
					/>
				</div>
			)}
		</PanelView>
	);
}
