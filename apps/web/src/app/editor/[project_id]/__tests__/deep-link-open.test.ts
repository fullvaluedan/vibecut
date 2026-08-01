import { describe, expect, test } from "bun:test";
import { parseOpenParam, resolveOpenParamAction } from "../deep-link-open";

describe("parseOpenParam", () => {
	test("accepts director/transcript/captions/ai-settings", () => {
		expect(parseOpenParam("director")).toBe("director");
		expect(parseOpenParam("transcript")).toBe("transcript");
		expect(parseOpenParam("captions")).toBe("captions");
		expect(parseOpenParam("ai-settings")).toBe("ai-settings");
	});

	test("ignores unknown values", () => {
		expect(parseOpenParam("bogus")).toBeNull();
		expect(parseOpenParam("Director")).toBeNull();
		expect(parseOpenParam("")).toBeNull();
	});

	test("ignores missing values", () => {
		expect(parseOpenParam(null)).toBeNull();
		expect(parseOpenParam(undefined)).toBeNull();
	});
});

describe("resolveOpenParamAction", () => {
	test("director opens the Director dock tab", () => {
		expect(resolveOpenParamAction("director")).toEqual({ store: "director" });
	});

	test("transcript opens the assets Transcript tab", () => {
		expect(resolveOpenParamAction("transcript")).toEqual({
			store: "assets",
			tab: "transcript",
		});
	});

	test("captions opens the assets Captions tab", () => {
		expect(resolveOpenParamAction("captions")).toEqual({
			store: "assets",
			tab: "captions",
		});
	});

	test("ai-settings opens the assets Settings tab on its AI sub-tab", () => {
		expect(resolveOpenParamAction("ai-settings")).toEqual({
			store: "assets",
			tab: "settings",
			settingsSubView: "ai",
		});
	});
});
