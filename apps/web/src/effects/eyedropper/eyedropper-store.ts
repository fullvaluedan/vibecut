/**
 * T19.2 eyedropper arming state. Clicking "Pick color" on a chroma-key effect
 * puts the request here; the preview overlay picks it up, samples a pixel, and
 * writes the result straight back into the effect's colour param through the
 * normal element-update command. Nothing about the effect itself is mirrored
 * here, only WHICH param is waiting for a colour.
 */

import { create } from "zustand";

export interface EyedropperRequest {
	trackId: string;
	elementId: string;
	effectId: string;
	paramKey: string;
}

interface EyedropperStore {
	request: EyedropperRequest | null;
	begin: (params: { request: EyedropperRequest }) => void;
	cancel: () => void;
}

export const useEyedropperStore = create<EyedropperStore>((set) => ({
	request: null,
	begin: ({ request }) => set({ request }),
	cancel: () => set({ request: null }),
}));

export function isSameEyedropperRequest({
	left,
	right,
}: {
	left: EyedropperRequest | null;
	right: EyedropperRequest;
}): boolean {
	return (
		left !== null &&
		left.trackId === right.trackId &&
		left.elementId === right.elementId &&
		left.effectId === right.effectId &&
		left.paramKey === right.paramKey
	);
}
