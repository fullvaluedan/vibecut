import type { FrameRate } from "opencut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";

declare global {
	interface Window {
		/** File System Access API — Chromium only, hence optional. */
		showSaveFilePicker?: (options: {
			id?: string;
			suggestedName?: string;
			types?: { description: string; accept: Record<string, string[]> }[];
		}) => Promise<FileSystemFileHandle>;
	}
}

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}

export type SaveLocation =
	| { kind: "handle"; handle: FileSystemFileHandle }
	| { kind: "cancelled" }
	| { kind: "unsupported" };

/**
 * Ask WHERE to save — up front, BEFORE a long encode, so a slow export isn't
 * wasted when the user cancels the dialog. The `id` makes the browser remember
 * the last export directory. Returns "unsupported" where the File System Access
 * API is unavailable (the caller then falls back to a plain download).
 */
export async function pickSaveLocation({
	filename,
	mimeType,
}: {
	filename: string;
	mimeType: string;
}): Promise<SaveLocation> {
	const picker = window.showSaveFilePicker;
	if (!picker) return { kind: "unsupported" };
	try {
		const extension = filename.includes(".")
			? `.${filename.split(".").pop()}`
			: ".mp4";
		const handle = await picker({
			id: "vibecut-export",
			suggestedName: filename,
			types: [{ description: "Video", accept: { [mimeType]: [extension] } }],
		});
		return { kind: "handle", handle };
	} catch (e) {
		if (e instanceof DOMException && e.name === "AbortError") {
			return { kind: "cancelled" };
		}
		// Picker failed for a non-cancel reason — fall back to a plain download.
		return { kind: "unsupported" };
	}
}

/** Write an already-encoded buffer to a handle picked earlier. */
export async function writeBufferToHandle({
	handle,
	buffer,
	mimeType,
}: {
	handle: FileSystemFileHandle;
	buffer: ArrayBuffer;
	mimeType: string;
}): Promise<void> {
	const writable = await handle.createWritable();
	await writable.write(new Blob([buffer], { type: mimeType }));
	await writable.close();
}

/**
 * Save with a real "where do I put this?" dialog (Chromium's File System Access
 * API), picking and writing in one step. Falls back to a plain download where
 * the API is unavailable; cancelling saves nothing. (For pick-first/encode-after
 * use `pickSaveLocation` + `writeBufferToHandle` directly.)
 */
export async function saveBufferWithPicker({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): Promise<"saved" | "cancelled" | "downloaded"> {
	const location = await pickSaveLocation({ filename, mimeType });
	if (location.kind === "cancelled") return "cancelled";
	if (location.kind === "unsupported") {
		downloadBuffer({ buffer, filename, mimeType });
		return "downloaded";
	}
	try {
		await writeBufferToHandle({ handle: location.handle, buffer, mimeType });
		return "saved";
	} catch {
		downloadBuffer({ buffer, filename, mimeType });
		return "downloaded";
	}
}
