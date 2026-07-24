import { describe, expect, test } from "bun:test";
import {
	filterFontsForTab,
	toggleFontFavorite,
	sanitizeFavorites,
} from "@/components/ui/font-picker";

/**
 * U4 (text round): the Font Picker's "My fonts"/"Favorites" tabs were dead UI
 * - filteredFonts never consulted activeTab, so every tab showed the same
 * full list. These test the pure pieces behind the real fix: the tab filter
 * and the favorites add/remove round-trip. The component itself can't be
 * rendered directly (this repo's `bun test` has no DOM), so these exercise
 * the exact functions FontPicker/FontRow call.
 */

const FONT_NAMES = ["Arial", "Georgia", "Roboto", "Verdana"];

describe("sanitizeFavorites", () => {
	test("a clean string array passes through unchanged", () => {
		const clean = ["Arial", "Georgia"];
		expect(sanitizeFavorites(clean)).toEqual(clean);
	});

	test("an array with non-string entries filters them out", () => {
		expect(sanitizeFavorites(["Arial", null, "Georgia", 42])).toEqual([
			"Arial",
			"Georgia",
		]);
	});

	test("a null value returns an empty array", () => {
		expect(sanitizeFavorites(null)).toEqual([]);
	});

	test("a number returns an empty array", () => {
		expect(sanitizeFavorites(123)).toEqual([]);
	});

	test("an object returns an empty array", () => {
		expect(sanitizeFavorites({ fonts: ["Arial"] })).toEqual([]);
	});

	test("an empty array stays empty", () => {
		expect(sanitizeFavorites([])).toEqual([]);
	});
});

describe("filterFontsForTab", () => {
	test("'all' tab returns every font name, ignoring favorites", () => {
		const result = filterFontsForTab({
			fontNames: FONT_NAMES,
			search: "",
			activeTab: "all",
			favorites: [],
		});
		expect(result).toEqual(FONT_NAMES);
	});

	test("'all' tab still applies the search filter (unchanged prior behavior)", () => {
		const result = filterFontsForTab({
			fontNames: FONT_NAMES,
			search: "ar",
			activeTab: "all",
			favorites: [],
		});
		expect(result).toEqual(["Arial"]);
	});

	test("'favorites' tab narrows to only starred families", () => {
		const result = filterFontsForTab({
			fontNames: FONT_NAMES,
			search: "",
			activeTab: "favorites",
			favorites: ["Georgia", "Roboto"],
		});
		expect(result).toEqual(["Georgia", "Roboto"]);
	});

	test("'favorites' tab with zero favorites returns an empty list, not the full list (the bug this fixes)", () => {
		const result = filterFontsForTab({
			fontNames: FONT_NAMES,
			search: "",
			activeTab: "favorites",
			favorites: [],
		});
		expect(result).toEqual([]);
	});

	test("'favorites' tab combines with search", () => {
		const result = filterFontsForTab({
			fontNames: FONT_NAMES,
			search: "geo",
			activeTab: "favorites",
			favorites: ["Georgia", "Roboto"],
		});
		expect(result).toEqual(["Georgia"]);
	});

	test("favorites that no longer exist in fontNames are silently dropped", () => {
		const result = filterFontsForTab({
			fontNames: FONT_NAMES,
			search: "",
			activeTab: "favorites",
			favorites: ["Some Deleted Font", "Roboto"],
		});
		expect(result).toEqual(["Roboto"]);
	});
});

describe("toggleFontFavorite", () => {
	test("stars a font that isn't favorited yet", () => {
		const result = toggleFontFavorite({ favorites: ["Arial"], family: "Georgia" });
		expect(result).toEqual(["Arial", "Georgia"]);
	});

	test("unstars a font that is already favorited", () => {
		const result = toggleFontFavorite({
			favorites: ["Arial", "Georgia"],
			family: "Arial",
		});
		expect(result).toEqual(["Georgia"]);
	});

	test("add then remove round-trips back to the original list", () => {
		const starred = toggleFontFavorite({ favorites: [], family: "Roboto" });
		const unstarred = toggleFontFavorite({ favorites: starred, family: "Roboto" });
		expect(unstarred).toEqual([]);
	});

	test("does not mutate the input array (immutable update)", () => {
		const original = ["Arial"];
		toggleFontFavorite({ favorites: original, family: "Georgia" });
		expect(original).toEqual(["Arial"]);
	});

	test("persistence shape: the round-trip always stays a flat array of family-name strings", () => {
		let favorites: string[] = [];
		favorites = toggleFontFavorite({ favorites, family: "Roboto" });
		favorites = toggleFontFavorite({ favorites, family: "Georgia" });
		expect(Array.isArray(favorites)).toBe(true);
		expect(favorites.every((entry) => typeof entry === "string")).toBe(true);
		expect(JSON.parse(JSON.stringify(favorites))).toEqual(["Roboto", "Georgia"]);
	});
});
