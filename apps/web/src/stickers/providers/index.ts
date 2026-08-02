import { stickersRegistry } from "../registry";
import type { StickerProvider } from "@/stickers/types";
import { flagsProvider } from "./flags";

// T19.4a prune: logos.ts (empty stub) and shapes.ts (duplicate of the live
// Shapes tab) were deleted. Flags is the only provider left - legacy sticker
// elements (`flags:us`) still need it to resolve at render/export time.
const defaultProviders: StickerProvider[] = [flagsProvider];

export function registerDefaultStickerProviders({
	providersToRegister = defaultProviders,
}: {
	providersToRegister?: StickerProvider[];
} = {}): void {
	for (const provider of providersToRegister) {
		if (stickersRegistry.has(provider.id)) {
			continue;
		}
		stickersRegistry.register({ key: provider.id, definition: provider });
	}
}
