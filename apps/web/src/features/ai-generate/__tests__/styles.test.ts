import { describe, expect, test } from "bun:test";
import { VIBE_STYLES, getStyleById } from "../styles";

describe("VIBE_STYLES factory defaults", () => {
	test("Swiss Grid white is the primary factory style", () => {
		expect(VIBE_STYLES[0].id).toBe("swiss");
		expect(VIBE_STYLES[0].name).toBe("Swiss Grid");
	});

	test("getStyleById falls back to Swiss Grid for an unknown id", () => {
		expect(getStyleById("does-not-exist").id).toBe("swiss");
	});
});
