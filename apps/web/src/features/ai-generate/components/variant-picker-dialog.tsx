"use client";

/**
 * "Pick what you like": after RUN HYPERFRAMES generates N whole-video versions
 * (each a distinct creative angle), this modal shows their rendered segments as
 * looping previews. Picking one places that version's segments across the
 * timeline; the others are discarded. Rendered like media-preview-dialog — a
 * tiny store + a Dialog mounted once at the toolbar root.
 */

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { placeHyperframesRenders } from "@/features/ai-generate/place-hyperframes-render";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import type { AuthoredVersion } from "@/features/ai-generate/run-hyperframes-scoped";

interface VariantPickerStore {
	versions: AuthoredVersion[] | null;
	open: (versions: AuthoredVersion[]) => void;
	close: () => void;
}

export const useVariantPickerStore = create<VariantPickerStore>((set) => ({
	versions: null,
	open: (versions) => set({ versions }),
	close: () => set({ versions: null }),
}));

/** Short title from an angle string like "bold / high-energy — punchy …". */
function angleTitle(angle: string): string {
	return angle.split(" — ")[0];
}

export function VariantPickerDialog() {
	const editor = useEditor();
	const versions = useVariantPickerStore((s) => s.versions);
	const close = useVariantPickerStore((s) => s.close);

	// One object URL per rendered segment; revoked when the set changes / closes.
	const urls = useMemo(() => {
		const m = new Map<File, string>();
		if (versions) {
			for (const v of versions) {
				for (const r of v.renders) m.set(r.file, URL.createObjectURL(r.file));
			}
		}
		return m;
	}, [versions]);
	useEffect(() => {
		return () => {
			for (const u of urls.values()) URL.revokeObjectURL(u);
		};
	}, [urls]);

	const placeVersion = async (v: AuthoredVersion) => {
		try {
			const placed = await placeHyperframesRenders({
				editor,
				renders: v.renders.map((r) => ({
					file: r.file,
					startSec: r.chunk.startSec,
					compId: r.compId,
					templateId: `authored:${r.compId ?? r.chunk.index}`,
					name: `HyperFrames: ${r.chunk.label}`,
				})),
			});
			if (placed > 0) usePreferenceStore.getState().noteGraphicsPlaced();
			toast.success(
				`Placed version ${v.index + 1} — ${placed} graphic segment${placed === 1 ? "" : "s"}`,
			);
			close();
		} catch (e) {
			toast.error("Could not place this version", {
				description: e instanceof Error ? e.message : String(e),
			});
		}
	};

	return (
		<Dialog
			open={!!versions}
			onOpenChange={(isOpen) => {
				if (!isOpen) close();
			}}
		>
			<DialogContent className="max-w-4xl p-6">
				<DialogTitle>Pick a HyperFrames version</DialogTitle>
				<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pt-1">
					{(versions ?? []).map((v) => (
						<div key={v.index} className="flex flex-col gap-2 rounded-md border p-3">
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
								<Button size="sm" onClick={() => void placeVersion(v)}>
									Use this version
								</Button>
							</div>
							<div className="flex flex-wrap gap-2">
								{v.renders.map((r) => (
									<video
										key={r.chunk.index}
										src={urls.get(r.file)}
										title={`segment ${r.chunk.label}`}
										autoPlay
										loop
										muted
										playsInline
										className="aspect-video h-20 rounded bg-black/60 object-contain"
									/>
								))}
							</div>
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
