import { describe, expect, test } from "bun:test";
import { parseOpenParam, resolveOpenParamAction } from "../deep-link-open";

describe("parseOpenParam", () => {
	test("accepts director/transcript/captions", () => {
		expect(parseOpenParam("director")).toBe("director");
		expect(parseOpenParam("transcript")).toBe("transcript");
		expect(parseOpenParam("captions")).toBe("captions");
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
});
