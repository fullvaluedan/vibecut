import type { ExportQuality, ExportResolution } from "./index";

/**
 * Standard mediabunny quality settings (in bits per second).
 * These map to the QUALITY_* constants from the encoder.
 */
const BITRATE_BY_QUALITY: Record<ExportQuality, number> = {
	low: 2_000_000,
	medium: 6_000_000,
	high: 12_000_000,
	very_high: 24_000_000,
};

/**
 * Compute output dimensions for a given resolution preset, preserving aspect ratio.
 * Non-project resolutions scale by height; width is derived from the project aspect.
 * Both width and height are rounded to even numbers for H.264/VP9 compatibility.
 */
export function deriveOutputSize({
	preset,
	projectWidth,
	projectHeight,
}: {
	preset: "project" | "2160" | "1080" | "720";
	projectWidth: number;
	projectHeight: number;
}): ExportResolution {
	if (preset === "project") {
		return { width: projectWidth, height: projectHeight };
	}

	const targetHeight = parseInt(preset, 10);
	const aspectRatio = projectWidth / projectHeight;
	const scaledWidth = targetHeight * aspectRatio;

	return {
		width: Math.round(scaledWidth / 2) * 2,
		height: Math.round(targetHeight / 2) * 2,
	};
}

/**
 * Calculate the effective bitrate for a resolution. Bitrate scales linearly with
 * pixel count: multiply the base QUALITY bitrate by (outputPixels / projectPixels).
 * Result is rounded to the nearest megabit.
 */
export function computeEffectiveBitrate({
	quality,
	projectPixels,
	outputPixels,
}: {
	quality: ExportQuality;
	projectPixels: number;
	outputPixels: number;
}): number {
	const baseBitrate = BITRATE_BY_QUALITY[quality];
	const scaledBitrate = baseBitrate * (outputPixels / projectPixels);
	return Math.round(scaledBitrate / 1_000_000);
}

/**
 * Format a bitrate in Mbps for display (e.g., "12 Mbps").
 */
export function formatBitrate(mbps: number): string {
	return `${mbps} Mbps`;
}
