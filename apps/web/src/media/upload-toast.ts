import { toast } from "sonner";

export interface MediaUploadToastResult {
	uploadedCount: number;
	assetNames?: string[];
}

function getAssetLabel({ count }: { count: number }): string {
	return count === 1 ? "media asset" : "media assets";
}

function waitForNextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

export async function showMediaUploadToast<T extends MediaUploadToastResult>({
	filesCount,
	promise,
}: {
	filesCount: number;
	promise: Promise<T> | (() => Promise<T>);
}) {
	const run = typeof promise === "function" ? promise : () => promise;
	const toastPromise = toast.promise(async () => {
		await waitForNextPaint();
		return run();
	}, {
		loading: `Uploading ${getAssetLabel({ count: filesCount })}...`,
		success: ({ uploadedCount, assetNames }) => {
			if (uploadedCount === 1) {
				const assetName = assetNames?.[0];
				return assetName
					? `${assetName} has been uploaded`
					: "1 media asset has been uploaded";
			}

			if (uploadedCount > 1) {
				return `${uploadedCount} media assets have been uploaded`;
			}

			// 0 uploaded means every file was unsupported/rejected (already surfaced
			// by per-file error toasts). Rendering a green "success" here contradicts
			// those — show a neutral info toast and suppress the success toast by
			// returning a falsy formatter result.
			toast.info("No media assets were uploaded");
			return undefined;
		},
		error: `Failed to upload ${getAssetLabel({ count: filesCount })}`,
	});

	return toastPromise.unwrap();
}
