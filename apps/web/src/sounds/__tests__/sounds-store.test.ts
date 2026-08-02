import { describe, expect, test } from "bun:test";
import { useSoundsStore } from "@/sounds/sounds-store";
import type { SoundEffect } from "@/sounds/types";

// T19.4a BUG 1: use-sound-search.ts's loadMore called these setters
// POSITIONALLY (e.g. `appendSearchResults(data.results)`) against an
// any-typed json() result. Every setter here takes an OBJECT arg
// (`{results}`/`{count}`), so a positional array destructures to
// `results: undefined` and `[...state.searchResults, ...undefined]` throws
// a TypeError - reproducing the "load more" crash on every page after the
// first. These tests exercise the exact object-shaped call convention
// use-sound-search.ts now uses, so a regression back to positional calls
// fails here (a TypeError) even before `bunx tsc` would catch it.

function sound({ id }: { id: number }): SoundEffect {
	return {
		id,
		name: `sound-${id}`,
		description: "",
		url: "",
		previewUrl: `https://example.com/${id}.mp3`,
		duration: 1,
		filesize: 100,
		type: "wav",
		channels: 2,
		bitrate: 128,
		bitdepth: 16,
		samplerate: 44100,
		username: "tester",
		tags: [],
		license: "Attribution",
		created: "2026-01-01T00:00:00Z",
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	};
}

describe("useSoundsStore append/set actions (T19.4a BUG 1 regression)", () => {
	test("appendSearchResults({results}) merges onto the existing search results without throwing", () => {
		useSoundsStore.getState().setSearchResults({ results: [sound({ id: 1 })] });
		useSoundsStore
			.getState()
			.appendSearchResults({ results: [sound({ id: 2 }), sound({ id: 3 })] });

		const { searchResults } = useSoundsStore.getState();
		expect(searchResults.map((s) => s.id)).toEqual([1, 2, 3]);
	});

	test("appendTopSounds({results}) merges onto the existing top-sounds list without throwing", () => {
		useSoundsStore.getState().setTopSoundEffects({ sounds: [sound({ id: 10 })] });
		useSoundsStore
			.getState()
			.appendTopSounds({ results: [sound({ id: 11 })] });

		const { topSoundEffects } = useSoundsStore.getState();
		expect(topSoundEffects.map((s) => s.id)).toEqual([10, 11]);
	});

	test("setTotalCount({count}) stores a real number, the shape loadMore now sends", () => {
		useSoundsStore.getState().setTotalCount({ count: 57 });
		expect(useSoundsStore.getState().totalCount).toBe(57);
	});

	test("needsFreesoundApiKey defaults false and is flippable via the object-shaped setter", () => {
		expect(useSoundsStore.getState().needsFreesoundApiKey).toBe(false);
		useSoundsStore.getState().setNeedsFreesoundApiKey({ needsKey: true });
		expect(useSoundsStore.getState().needsFreesoundApiKey).toBe(true);
		useSoundsStore.getState().setNeedsFreesoundApiKey({ needsKey: false });
		expect(useSoundsStore.getState().needsFreesoundApiKey).toBe(false);
	});
});
