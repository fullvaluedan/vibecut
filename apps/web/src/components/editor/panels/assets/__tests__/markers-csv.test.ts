import { describe, expect, test } from "bun:test";
import { buildMarkersCsv } from "@/components/editor/panels/assets/markers-csv";

describe("buildMarkersCsv", () => {
	test("returns header only for an empty list", () => {
		expect(buildMarkersCsv({ markers: [] })).toBe("timecode,comment,color");
	});

	test("renders one row per marker", () => {
		const csv = buildMarkersCsv({
			markers: [
				{ timecode: "00:00:01:00", comment: "Intro", color: "#009dff" },
				{ timecode: "00:00:05:00", comment: "Cut", color: "#ff6900" },
			],
		});

		expect(csv).toBe(
			[
				"timecode,comment,color",
				"00:00:01:00,Intro,#009dff",
				"00:00:05:00,Cut,#ff6900",
			].join("\n"),
		);
	});

	test("quotes a comment containing a comma", () => {
		const csv = buildMarkersCsv({
			markers: [
				{ timecode: "00:00:01:00", comment: "hello, world", color: "#009dff" },
			],
		});

		expect(csv).toBe(
			['timecode,comment,color', '00:00:01:00,"hello, world",#009dff'].join(
				"\n",
			),
		);
	});

	test("doubles and quotes a comment containing a double quote", () => {
		const csv = buildMarkersCsv({
			markers: [
				{ timecode: "00:00:01:00", comment: 'say "hi"', color: "#009dff" },
			],
		});

		expect(csv).toBe(
			['timecode,comment,color', '00:00:01:00,"say ""hi""",#009dff'].join(
				"\n",
			),
		);
	});

	test("quotes a comment containing a newline", () => {
		const csv = buildMarkersCsv({
			markers: [{ timecode: "00:00:01:00", comment: "line1\nline2" }],
		});

		expect(csv).toBe(
			['timecode,comment,color', '00:00:01:00,"line1\nline2",'].join("\n"),
		);
	});

	test("renders empty fields for a marker with no comment or color", () => {
		const csv = buildMarkersCsv({
			markers: [{ timecode: "00:00:01:00" }],
		});

		expect(csv).toBe(
			["timecode,comment,color", "00:00:01:00,,"].join("\n"),
		);
	});

	test("preserves list order", () => {
		const csv = buildMarkersCsv({
			markers: [
				{ timecode: "00:00:03:00", comment: "c" },
				{ timecode: "00:00:01:00", comment: "a" },
				{ timecode: "00:00:02:00", comment: "b" },
			],
		});

		expect(csv).toBe(
			[
				"timecode,comment,color",
				"00:00:03:00,c,",
				"00:00:01:00,a,",
				"00:00:02:00,b,",
			].join("\n"),
		);
	});
});
