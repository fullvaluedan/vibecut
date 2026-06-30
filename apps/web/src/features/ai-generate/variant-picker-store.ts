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

export interface VariantPickerStore {
	/** The generated drafts. Survives modal close; only discard()/apply clears it. */
	versions: AuthoredVersion[] | null;
	/** Modal visibility, independent of whether drafts exist. */
	isOpen: boolean;
	/** One object URL per render File, shared by every preview surface. */
	urls: Map<File, string>;
	/** Set fresh drafts (revoking any previous URLs) and open the modal. */
	open: (versions: AuthoredVersion[]) => void;
	/** Reopen the modal with the retained drafts (no-op if none). */
	show: () => void;
	/** Hide the modal but KEEP the drafts + URLs (recoverable). */
	close: () => void;
	/** Clear the drafts and revoke their URLs (the only destructive exit). */
	discard: () => void;
}

function buildUrls(versions: AuthoredVersion[]): Map<File, string> {
	const m = new Map<File, string>();
	for (const v of versions) {
		for (const r of v.renders) m.set(r.file, URL.createObjectURL(r.file));
	}
	return m;
}

function revokeUrls(urls: Map<File, string>): void {
	for (const u of urls.values()) URL.revokeObjectURL(u);
}

export const useVariantPickerStore = create<VariantPickerStore>((set, get) => ({
	versions: null,
	isOpen: false,
	urls: new Map(),
	open: (versions) => {
		revokeUrls(get().urls);
		set({ versions, urls: buildUrls(versions), isOpen: true });
	},
	show: () => set((s) => (s.versions ? { isOpen: true } : {})),
	close: () => set({ isOpen: false }),
	discard: () => {
		revokeUrls(get().urls);
		set({ versions: null, urls: new Map(), isOpen: false });
	},
}));

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
