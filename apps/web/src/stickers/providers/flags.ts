import { parseStickerId } from "../sticker-id";
import type { StickerProvider } from "../types";

const FLAGS_PROVIDER_ID = "flags";
const DEFAULT_FLAGS_BASE_URL = "/flags";

function getFlagsBaseUrl(): string {
	return DEFAULT_FLAGS_BASE_URL.replace(/\/$/, "");
}

export function buildFlagUrl({ code }: { code: string }): string {
	const normalizedCode = code.toLowerCase();
	return `${getFlagsBaseUrl()}/${encodeURIComponent(normalizedCode)}.svg`;
}

/**
 * Resolve-only spine (T19.4a prune): search/browse (country lookup,
 * region-alias matching, pagination) were deleted as dead code alongside the
 * browse/search API in index.ts. `resolveUrl` is the one method legacy
 * sticker elements (`flags:us`) still need at render/export time.
 */
export const flagsProvider: StickerProvider = {
	id: FLAGS_PROVIDER_ID,
	resolveUrl({
		stickerId,
	}: {
		stickerId: string;
		options?: { width?: number; height?: number };
	}): string {
		const { providerValue } = parseStickerId({ stickerId });
		return buildFlagUrl({ code: providerValue });
	},
};
