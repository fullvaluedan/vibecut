"use client";

/**
 * Double-click an asset in the media bin → a preview window, like every NLE.
 * A tiny store holds the asset being previewed so the dialog can be rendered
 * once at the panel root without prop-drilling through the item tree.
 */

import { create } from "zustand";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { MediaAsset } from "@/media/types";

interface MediaPreviewStore {
	asset: MediaAsset | null;
	open: (asset: MediaAsset) => void;
	close: () => void;
}

export const useMediaPreviewStore = create<MediaPreviewStore>((set) => ({
	asset: null,
	open: (asset) => set({ asset }),
	close: () => set({ asset: null }),
}));

export function MediaPreviewDialog() {
	const asset = useMediaPreviewStore((s) => s.asset);
	const close = useMediaPreviewStore((s) => s.close);

	return (
		<Dialog
			open={!!asset}
			onOpenChange={(isOpen) => {
				if (!isOpen) close();
			}}
		>
			<DialogContent className="max-w-3xl overflow-hidden p-0">
				<DialogTitle className="sr-only">
					{asset?.name ?? "Preview"}
				</DialogTitle>
				{asset && (
					<div className="flex flex-col">
						<div className="flex max-h-[70vh] items-center justify-center bg-black">
							{asset.type === "video" ? (
								// eslint-disable-next-line jsx-a11y/media-has-caption
								<video
									src={asset.url}
									controls
									autoPlay
									className="max-h-[70vh] w-full"
								/>
							) : asset.type === "audio" ? (
								// eslint-disable-next-line jsx-a11y/media-has-caption
								<audio src={asset.url} controls autoPlay className="w-full p-8" />
							) : (
								<img
									src={asset.url}
									alt={asset.name}
									className="max-h-[70vh] w-full object-contain"
								/>
							)}
						</div>
						<div className="text-foreground truncate border-t px-4 py-2 text-sm font-medium">
							{asset.name}
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
