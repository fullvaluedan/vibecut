"use client";

/**
 * Variant-picker draft store + the pure apply-mapping, split out of
 * variant-picker-dialog.tsx so the object-URL lifecycle and the placement
 * mapping are unit-testable WITHOUT the dialog's React / editor / render
 * imports (mirrors transcript-scope.ts and chunk-plan.ts).
 *
 * Drafts PERSIST: close() hides the modal but KEEPS versions + their object URLs;
 * only discard() (or applying a version) clears them and revokes the URLs.
 */

import { create } from "zustand";
import type { AuthoredVersion } from "@/features/ai-generate/run-hyperframes-scoped";
import type { ChunkRenderInput } from "@/features/ai-generate/place-hyperframes-render";
import type { AuthorChunk } from "@/features/ai-generate/chunk-plan";

export type ProbeStatus = "probed" | "rendering" | "rendered" | "failed";

export interface ProbeDraft {
	chunk: AuthorChunk;
	/** The short probe WebM (absent only for a reused-chunk placeholder). */
	file?: File;
	/** The authored comp this chunk renders from (set once authoring succeeds). */
	compId?: string;
	/** The compiled brief; lets a failed probe re-author without the run inputs. */
	brief?: string;
	status: ProbeStatus;
	error?: string;
}

/**
 * One run's probe contact sheet. Lives in the store like the version drafts:
 * close() KEEPS it (approved included), so closing the review never forces a
 * re-probe; only discard()/a successful full render clears it.
 */
export interface ProbeSet {
	runId: string;
	scopeLabel: string;
	/** The gate: the full render is BLOCKED until this is true. */
	approved: boolean;
	canvas: { width: number; height: number; fps: number };
	probes: ProbeDraft[];
	/** Chunks already placed on the timeline (never placed twice on retry). */
	placedChunkIndexes: number[];
}

export interface VariantPickerStore {
	/** The generated drafts. Survives modal close; only discard()/apply clears it. */
	versions: AuthoredVersion[] | null;
	/** A run's probe set awaiting approval (same persistence as versions). */
	probeSet: ProbeSet | null;
	/** The full render of an approved probe set is in flight. */
	probeRendering: boolean;
	/** Modal visibility, independent of whether drafts exist. */
	isOpen: boolean;
	/** One object URL per render/probe File, shared by every preview surface. */
	urls: Map<File, string>;
	/** Set fresh drafts (revoking any previous URLs) and open the modal. */
	open: (versions: AuthoredVersion[]) => void;
	/** Set a fresh probe set (unapproved) and open the modal for review. */
	openProbes: (probeSet: ProbeSet) => void;
	/** Approve the probe set; persists across close(), so no re-probe on reopen. */
	approveProbes: () => void;
	/** Re-arm the gate after a retry re-authored a probe (new unreviewed content). */
	resetProbeApproval: () => void;
	/** Patch one probe (status/compId/file/error) during render + retry. */
	updateProbe: (index: number, patch: Partial<ProbeDraft>) => void;
	/** Record chunks placed on the timeline so a retry never double-places. */
	markProbesPlaced: (indexes: number[]) => void;
	setProbeRendering: (rendering: boolean) => void;
	/** Clear the probe set and revoke its URLs. */
	discardProbes: () => void;
	/** Reopen the modal with the retained drafts (no-op if none). */
	show: () => void;
	/** Hide the modal but KEEP the drafts + URLs (recoverable). */
	close: () => void;
	/** Clear the drafts and revoke their URLs (the only destructive exit). */
	discard: () => void;
}

function collectFiles(
	versions: AuthoredVersion[] | null,
	probeSet: ProbeSet | null,
): File[] {
	const files: File[] = [];
	for (const v of versions ?? []) {
		for (const r of v.renders) files.push(r.file);
	}
	for (const p of probeSet?.probes ?? []) {
		if (p.file) files.push(p.file);
	}
	return files;
}

function buildUrls(files: File[]): Map<File, string> {
	const m = new Map<File, string>();
	for (const f of files) m.set(f, URL.createObjectURL(f));
	return m;
}

function revokeUrls(urls: Map<File, string>): void {
	for (const u of urls.values()) URL.revokeObjectURL(u);
}

export const useVariantPickerStore = create<VariantPickerStore>((set, get) => ({
	versions: null,
	probeSet: null,
	probeRendering: false,
	isOpen: false,
	urls: new Map(),
	open: (versions) => {
		revokeUrls(get().urls);
		set({
			versions,
			urls: buildUrls(collectFiles(versions, get().probeSet)),
			isOpen: true,
		});
	},
	openProbes: (probeSet) => {
		revokeUrls(get().urls);
		set({
			probeSet,
			probeRendering: false,
			urls: buildUrls(collectFiles(get().versions, probeSet)),
			isOpen: true,
		});
	},
	approveProbes: () =>
		set((s) =>
			s.probeSet ? { probeSet: { ...s.probeSet, approved: true } } : {},
		),
	resetProbeApproval: () =>
		set((s) =>
			s.probeSet ? { probeSet: { ...s.probeSet, approved: false } } : {},
		),
	markProbesPlaced: (indexes) =>
		set((s) =>
			s.probeSet
				? {
						probeSet: {
							...s.probeSet,
							placedChunkIndexes: [
								...new Set([...s.probeSet.placedChunkIndexes, ...indexes]),
							],
						},
					}
				: {},
		),
	updateProbe: (index, patch) =>
		set((s) => {
			if (!s.probeSet) return {};
			const probes = s.probeSet.probes.map((p) =>
				p.chunk.index === index ? { ...p, ...patch } : p,
			);
			// A swapped-in probe file needs its own object URL.
			const urls = new Map(s.urls);
			const added = probes.find((p) => p.chunk.index === index)?.file;
			if (added && !urls.has(added)) urls.set(added, URL.createObjectURL(added));
			return { probeSet: { ...s.probeSet, probes }, urls };
		}),
	setProbeRendering: (probeRendering) => set({ probeRendering }),
	discardProbes: () => {
		const s = get();
		revokeUrls(s.urls);
		set({
			probeSet: null,
			probeRendering: false,
			urls: buildUrls(collectFiles(s.versions, null)),
		});
	},
	show: () => set((s) => (s.versions || s.probeSet ? { isOpen: true } : {})),
	close: () => set({ isOpen: false }),
	discard: () => {
		revokeUrls(get().urls);
		set({
			versions: null,
			probeSet: null,
			probeRendering: false,
			urls: new Map(),
			isOpen: false,
		});
	},
}));

/**
 * True when any drafts exist (version drafts OR a probe set awaiting
 * approval). Drives the empty-inspector drafts-panel takeover
 * (`properties/index.tsx`) and the toolbar's reopen-drafts affordance, so
 * the probe gate surfaces in the UI even with zero versions generated.
 */
export function hasVariantDrafts(
	s: Pick<VariantPickerStore, "versions" | "probeSet">,
): boolean {
	return (s.versions?.length ?? 0) > 0 || !!s.probeSet;
}

/**
 * Map a version's segments to placeHyperframesRenders args (one new track, one
 * undo). Pure: the templateId fallback (`authored:${compId ?? chunk.index}`) and
 * the per-render shape are the load-bearing bits, kept testable apart from the
 * editor-bound place call in applyVariantVersion.
 */
export function buildVersionPlacements(v: AuthoredVersion): ChunkRenderInput[] {
	return v.renders.map((r) => ({
		file: r.file,
		startSec: r.chunk.startSec,
		compId: r.compId,
		templateId: `authored:${r.compId ?? r.chunk.index}`,
		name: `HyperFrames: ${r.chunk.label}`,
		brief: r.brief,
	}));
}
