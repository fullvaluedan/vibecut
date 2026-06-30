"use client";

/**
 * Re-accessible drafts surface for the inspector. After RUN HYPERFRAMES generates
 * versions, the drafts persist in the variant-picker store; this panel renders them
 * IN the right-hand inspector area (alongside Transform/Audio) so the user can
 * review + apply without reopening a lost modal. It reads from the store rather
 * than element selection, because the drafts exist BEFORE any clip is placed (there
 * is nothing on the timeline to select yet) — so it docks in the inspector's
 * empty-selection state whenever drafts are present.
 */

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import {
	useVariantPickerStore,
	VariantVersionReview,
	applyVariantVersion,
} from "@/features/ai-generate/components/variant-picker-dialog";
import type { AuthoredVersion } from "@/features/ai-generate/run-hyperframes-scoped";

export function HyperframesDraftsPanel() {
	const editor = useEditor();
	const versions = useVariantPickerStore((s) => s.versions);
	const urls = useVariantPickerStore((s) => s.urls);
	const discard = useVariantPickerStore((s) => s.discard);

	if (!versions?.length) return null;

	const apply = async (v: AuthoredVersion) => {
		try {
			// Places on a new track (one undo) and clears the remaining drafts.
			await applyVariantVersion(editor, v);
		} catch (e) {
			toast.error("Could not place this version", {
				description: e instanceof Error ? e.message : String(e),
			});
		}
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
				<div className="min-w-0">
					<div className="text-sm font-medium">HyperFrames versions</div>
					<div className="text-muted-foreground text-xs">
						{versions.length} draft{versions.length === 1 ? "" : "s"} ready —
						review and apply one.
					</div>
				</div>
				<Button
					variant="destructive"
					size="sm"
					className="shrink-0"
					onClick={discard}
				>
					Discard
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto p-3">
				<VariantVersionReview
					versions={versions}
					urls={urls}
					onApply={apply}
				/>
			</div>
		</div>
	);
}
