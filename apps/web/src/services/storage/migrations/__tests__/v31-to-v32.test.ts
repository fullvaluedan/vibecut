import { describe, expect, test } from "bun:test";
import { transformProjectV31ToV32 } from "../transformers/v31-to-v32";
import { asRecord, asRecordArray } from "./helpers";

describe("V31 to V32 Migration", () => {
	test("backfills expand: 0 on masks missing the param", () => {
		const result = transformProjectV31ToV32({
			project: {
				id: "project-v31-expand",
				version: 31,
				scenes: [
					{
						tracks: {
							main: {
								elements: [
									{
										id: "image-1",
										type: "image",
										masks: [
											{
												id: "mask-1",
												type: "rectangle",
												params: { feather: 0, width: 0.6, height: 0.6 },
											},
										],
									},
								],
							},
						},
					},
				],
			},
		});

		expect(result.skipped).toBe(false);
		expect(result.project.version).toBe(32);
		const scene = asRecordArray(result.project.scenes)[0];
		const main = asRecord(asRecord(scene.tracks).main);
		const element = asRecordArray(main.elements)[0];
		const mask = asRecordArray(asRecord(element).masks)[0];
		expect(asRecord(mask.params).expand).toBe(0);
		// Pre-existing params are preserved.
		expect(asRecord(mask.params).feather).toBe(0);
		expect(asRecord(mask.params).width).toBe(0.6);
	});

	test("leaves an existing numeric expand untouched", () => {
		const result = transformProjectV31ToV32({
			project: {
				id: "project-v31-has-expand",
				version: 31,
				scenes: [
					{
						tracks: {
							overlay: [
								{
									elements: [
										{
											id: "elem-1",
											masks: [
												{ id: "m1", type: "ellipse", params: { expand: 12 } },
											],
										},
									],
								},
							],
						},
					},
				],
			},
		});

		expect(result.skipped).toBe(false);
		const scene = asRecordArray(result.project.scenes)[0];
		const overlay = asRecordArray(asRecord(scene.tracks).overlay)[0];
		const element = asRecordArray(asRecord(overlay).elements)[0];
		const mask = asRecordArray(asRecord(element).masks)[0];
		expect(asRecord(mask.params).expand).toBe(12);
	});

	test("leaves elements without a masks array unchanged", () => {
		const result = transformProjectV31ToV32({
			project: {
				id: "project-v31-no-masks",
				version: 31,
				scenes: [
					{
						tracks: {
							main: {
								elements: [{ id: "elem-1", type: "video" }],
							},
						},
					},
				],
			},
		});

		expect(result.skipped).toBe(false);
		const scene = asRecordArray(result.project.scenes)[0];
		const main = asRecord(asRecord(scene.tracks).main);
		const element = asRecordArray(main.elements)[0];
		expect(element).toMatchObject({ id: "elem-1", type: "video" });
	});

	test("skips a project that is already v32", () => {
		const project = { id: "p1", version: 32, scenes: [] };
		const result = transformProjectV31ToV32({ project });
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("already v32");
		expect(result.project).toBe(project);
	});

	test("skips a project that is not v31", () => {
		const project = { id: "p1", version: 30, scenes: [] };
		const result = transformProjectV31ToV32({ project });
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("not v31");
		expect(result.project).toBe(project);
	});
});
