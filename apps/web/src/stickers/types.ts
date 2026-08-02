/**
 * Trimmed T19.4a (stickers prune): the browse/search API (index.ts) and its
 * provider-side implementations (logos.ts, shapes.ts, the browse/search half
 * of flags.ts) were deleted as dead code (zero callers). What remains is the
 * resolve spine - `resolveStickerId` needs a provider that can turn a sticker
 * ID into a URL, nothing else - kept because legacy projects still contain
 * sticker elements that must resolve + render + export.
 */
export interface StickerResolveOptions {
	width?: number;
	height?: number;
}

export interface StickerProvider {
	id: string;
	resolveUrl({
		stickerId,
		options,
	}: {
		stickerId: string;
		options?: StickerResolveOptions;
	}): string;
}
