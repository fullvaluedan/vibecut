"use client";

/**
 * "Pick what you like": after RUN HYPERFRAMES generates N whole-video versions
 * (each a distinct creative angle), this modal shows their rendered segments as
 * previews. Picking one places that version's segments across the timeline; the
 * others are discarded.
 *
 * Drafts PERSIST: closing the modal hides it but KEEPS the versions (and their
 * object URLs) so the user can reopen and review them — only an explicit Discard
 * (or applying a version) clears them and revokes the URLs. The object URLs live
 * in the store, one per render File, so the modal AND the re-accessible drafts
 * surface (HyperframesDraftsPanel) share them without double-allocating.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import type { EditorCore } from "@/core";
import { placeHyperframesRenders } from "@/features/ai-generate/place-hyperframes-render";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import type { AuthoredVersion } from "@/features/ai-generate/run-hyperframes-scoped";
import {
	renderApprovedProbeSet,
	retryProbeChunk,
} from "@/features/ai-generate/run-hyperframes-scoped";
import {
	useVariantPickerStore,
	buildVersionPlacements,
	type ProbeSet,
} from "@/features/ai-generate/variant-picker-store";

// The draft store + object-URL lifecycle live in variant-picker-store.ts (pure,
// unit-tested). Re-exported so existing importers keep their import path.
export { useVariantPickerStore };

/** Short title from an angle string like "bold / high-energy — punchy …". */
function angleTitle(angle: string): string {
	return angle.split(" — ")[0];
}

/**
 * Place a version's segments on a new track (one undo) and clear the rest. Shared
 * by the modal and the docked drafts panel so "Apply" behaves identically.
 */
export async function applyVariantVersion(
	editor: EditorCore,
	v: AuthoredVersion,
): Promise<void> {
	const placed = await placeHyperframesRenders({
		editor,
		renders: buildVersionPlacements(v),
	});
	if (placed > 0) usePreferenceStore.getState().noteGraphicsPlaced();
	toast.success(
		`Placed version ${v.index + 1} — ${placed} graphic segment${placed === 1 ? "" : "s"}`,
	);
	// Applying commits one version; the others are no longer needed.
	useVariantPickerStore.getState().discard();
}

/**
 * The reviewable list of versions: enlarged, readable preview tiles per version,
 * each tile click-to-expand into a full-size scrubbable player. Reused by the
 * modal and the docked drafts panel. `urls` come from the store (shared).
 */
export function VariantVersionReview({
	versions,
	urls,
	onApply,
}: {
	versions: AuthoredVersion[];
	urls: Map<File, string>;
	onApply: (v: AuthoredVersion) => void;
}) {
	// Expand on demand — we don't blow up every segment to full size at once.
	const [expanded, setExpanded] = useState<File | null>(null);

	return (
		<div className="flex flex-col gap-4">
			{versions.map((v) => (
				<div
					key={v.index}
					className="flex flex-col gap-2 rounded-md border p-3"
				>
					<div className="flex items-center gap-2">
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-medium">
								Version {v.index + 1} — {angleTitle(v.angle)}
							</div>
							<div className="text-muted-foreground text-xs">
								{v.renders.length} graphic segment
								{v.renders.length === 1 ? "" : "s"} across the video
							</div>
						</div>
						<Button size="sm" onClick={() => onApply(v)}>
							Use this version
						</Button>
					</div>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{v.renders.map((r) => (
							<button
								key={r.chunk.index}
								type="button"
								onClick={() => setExpanded(r.file)}
								title={`segment ${r.chunk.label} — click to enlarge & scrub`}
								className="group relative overflow-hidden rounded bg-black/60 ring-offset-2 transition hover:ring-2 hover:ring-primary"
							>
								<video
									src={urls.get(r.file)}
									autoPlay
									loop
									muted
									playsInline
									className="aspect-video w-full object-contain"
								/>
								<span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
									⤢ enlarge & scrub
								</span>
							</button>
						))}
					</div>
				</div>
			))}

			{expanded && (
				<div
					className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/85 p-6"
					onClick={() => setExpanded(null)}
				>
					{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
					<video
						src={urls.get(expanded)}
						controls
						autoPlay
						loop
						onClick={(e) => e.stopPropagation()}
						className="max-h-[80vh] max-w-full rounded bg-black"
					/>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => setExpanded(null)}
					>
						Close preview
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * Approve the probe set and run the full render + placement. Shared by the
 * modal and the docked drafts panel so "Approve" behaves identically.
 */
export async function approveProbesAndRender(editor: EditorCore): Promise<void> {
	useVariantPickerStore.getState().approveProbes();
	try {
		const { placed, failed } = await renderApprovedProbeSet({ editor });
		if (failed > 0) {
			toast.info(
				`Placed ${placed} segment${placed === 1 ? "" : "s"}; ${failed} failed`,
				{ description: "Failed segments stay in drafts with a Retry button." },
			);
		} else {
			toast.success(
				`Placed ${placed} graphic segment${placed === 1 ? "" : "s"} across the video`,
			);
		}
	} catch (e) {
		toast.error("Full render failed", {
			description: e instanceof Error ? e.message : String(e),
		});
	}
}

/** Retry one failed chunk (re-render, or re-author when it never authored). */
export async function retryProbe(
	editor: EditorCore,
	index: number,
): Promise<void> {
	try {
		await retryProbeChunk({ editor, index });
	} catch (e) {
		toast.error("Retry failed", {
			description: e instanceof Error ? e.message : String(e),
		});
	}
}

const PROBE_STATUS_LABEL: Record<string, string> = {
	probed: "probe ready",
	rendering: "rendering…",
	rendered: "rendered",
	failed: "failed",
};

/**
 * The probe contact sheet: one thumbnail + one-click play per segment probe,
 * an approve button that gates the full render, and per-chunk Retry for
 * failures. Rides the same tile pattern as the version review below; reused
 * by the modal and the docked drafts panel.
 */
export function ProbeSetReview({
	probeSet,
	urls,
	rendering,
	onApprove,
	onRetry,
}: {
	probeSet: ProbeSet;
	urls: Map<File, string>;
	rendering: boolean;
	onApprove: () => void;
	onRetry: (index: number) => void;
}) {
	const [expanded, setExpanded] = useState<File | null>(null);
	const failedCount = probeSet.probes.filter(
		(p) => p.status === "failed",
	).length;

	return (
		<div className="flex flex-col gap-2 rounded-md border p-3">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">
						Probe review: {probeSet.scopeLabel}
					</div>
					<div className="text-muted-foreground text-xs">
						{probeSet.probes.length} probe
						{probeSet.probes.length === 1 ? "" : "s"} (first seconds of each
						segment); the full render is blocked until you approve.
					</div>
				</div>
				<Button
					size="sm"
					disabled={rendering || (probeSet.approved && failedCount === 0)}
					onClick={onApprove}
				>
					{rendering
						? "Rendering…"
						: probeSet.approved
							? "Approved"
							: "Approve & render full pass"}
				</Button>
			</div>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
				{probeSet.probes.map((p) => (
					<div
						key={p.chunk.index}
						className="group relative overflow-hidden rounded bg-black/60"
					>
						{p.file ? (
							<button
								type="button"
								onClick={() => setExpanded(p.file!)}
								title={`segment ${p.chunk.label} — click to enlarge & scrub`}
								className="block w-full ring-offset-2 transition hover:ring-2 hover:ring-primary"
							>
								<video
									src={urls.get(p.file)}
									autoPlay
									loop
									muted
									playsInline
									className="aspect-video w-full object-contain"
								/>
							</button>
						) : (
							<div className="text-muted-foreground flex aspect-video w-full items-center justify-center text-[10px]">
								no preview
							</div>
						)}
						<span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">
							{p.chunk.label} · {PROBE_STATUS_LABEL[p.status] ?? p.status}
						</span>
						{p.status === "failed" && (
							<div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 p-2">
								<span
									className="max-w-full truncate text-[10px] text-red-300"
									title={p.error}
								>
									{p.error ?? "failed"}
								</span>
								<Button
									size="sm"
									variant="secondary"
									disabled={rendering}
									onClick={() => onRetry(p.chunk.index)}
								>
									Retry
								</Button>
							</div>
						)}
					</div>
				))}
			</div>

			{expanded && (
				<div
					className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/85 p-6"
					onClick={() => setExpanded(null)}
				>
					{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
					<video
						src={urls.get(expanded)}
						controls
						autoPlay
						loop
						onClick={(e) => e.stopPropagation()}
						className="max-h-[80vh] max-w-full rounded bg-black"
					/>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => setExpanded(null)}
					>
						Close preview
					</Button>
				</div>
			)}
		</div>
	);
}

export function VariantPickerDialog() {
	const editor = useEditor();
	const versions = useVariantPickerStore((s) => s.versions);
	const probeSet = useVariantPickerStore((s) => s.probeSet);
	const probeRendering = useVariantPickerStore((s) => s.probeRendering);
	const isOpen = useVariantPickerStore((s) => s.isOpen);
	const urls = useVariantPickerStore((s) => s.urls);
	const close = useVariantPickerStore((s) => s.close);
	const discard = useVariantPickerStore((s) => s.discard);

	const placeVersion = async (v: AuthoredVersion) => {
		try {
			await applyVariantVersion(editor, v);
		} catch (e) {
			toast.error("Could not place this version", {
				description: e instanceof Error ? e.message : String(e),
			});
		}
	};

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				// Closing the modal KEEPS the drafts (recoverable) — only the explicit
				// Discard button clears them.
				if (!open) close();
			}}
		>
			<DialogContent className="max-w-5xl p-6">
				<DialogTitle>
					{probeSet ? "Review HyperFrames probes" : "Pick a HyperFrames version"}
				</DialogTitle>
				<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pt-1">
					{probeSet && (
						<ProbeSetReview
							probeSet={probeSet}
							urls={urls}
							rendering={probeRendering}
							onApprove={() => void approveProbesAndRender(editor)}
							onRetry={(i) => void retryProbe(editor, i)}
						/>
					)}
					{(versions ?? []).length > 0 && (
						<VariantVersionReview
							versions={versions ?? []}
							urls={urls}
							onApply={placeVersion}
						/>
					)}
				</div>
				<div className="flex items-center justify-between gap-3 pt-2">
					<p className="text-muted-foreground text-xs">
						Your drafts stay here until you apply or discard — closing keeps
						them.
					</p>
					<div className="flex shrink-0 gap-2">
						<Button variant="ghost" size="sm" onClick={close}>
							Close (keep drafts)
						</Button>
						<Button variant="destructive" size="sm" onClick={discard}>
							Discard drafts
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
