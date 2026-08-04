import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createRunManifest,
	transitionChunk,
	markApproved,
	matchReusableChunks,
	revalidateManifest,
	type RunManifest,
} from "../run-manifest";
import {
	loadRunManifest,
	saveRunManifest,
	compDirStatus,
	loadRevalidatedManifest,
} from "../run-manifest-store";

const NOW = "2026-08-03T00:00:00.000Z";

function manifest(chunkCount = 3): RunManifest {
	return createRunManifest({
		runId: "run-test",
		scope: { startSec: 0, endSec: chunkCount * 90 },
		canvas: { width: 1920, height: 1080, fps: 30 },
		chunks: Array.from({ length: chunkCount }, (_, i) => ({
			index: i,
			startSec: i * 90,
			endSec: (i + 1) * 90,
		})),
		now: NOW,
	});
}

describe("run-manifest state machine", () => {
	test("createRunManifest starts every chunk pending", () => {
		const m = manifest();
		expect(m.chunks.map((c) => c.state)).toEqual([
			"pending",
			"pending",
			"pending",
		]);
		expect(m.approved).toBe(false);
		expect(m.createdAt).toBe(NOW);
	});

	test("the happy path: pending -> probed -> rendered", () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "probed", { compId: "comp-a" });
		expect(m.chunks[0].state).toBe("probed");
		expect(m.chunks[0].compId).toBe("comp-a");
		m = transitionChunk(m, 0, "rendered");
		expect(m.chunks[0].state).toBe("rendered");
		expect(m.chunks[0].compId).toBe("comp-a"); // kept
	});

	test("failure records the error; success clears it", () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "failed", { error: "author boom" });
		expect(m.chunks[0].error).toBe("author boom");
		m = transitionChunk(m, 0, "probed", { compId: "comp-b" });
		expect(m.chunks[0].error).toBeUndefined();
	});

	test("the brief rides the patch so reused chunks keep it (R20-1)", () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "probed", {
			compId: "comp-a",
			brief: "the authored brief",
		});
		expect(m.chunks[0].brief).toBe("the authored brief");
		// Later transitions without a brief patch keep it.
		m = transitionChunk(m, 0, "rendered");
		expect(m.chunks[0].brief).toBe("the authored brief");
	});

	test("illegal transitions throw", () => {
		const m = manifest(1);
		expect(() => transitionChunk(m, 0, "rendered")).toThrow(
			/Illegal chunk transition/,
		);
		expect(() => transitionChunk(m, 0, "pending")).toThrow(
			/Illegal chunk transition/,
		);
		expect(() => transitionChunk(m, 9, "probed")).toThrow(/No chunk 9/);
	});

	test("retry: failed -> probed (re-author) and failed -> rendered (re-render kept compId)", () => {
		let m = manifest(2);
		// chunk 0 failed at authoring (no compId): retry re-authors
		m = transitionChunk(m, 0, "failed", { error: "boom" });
		m = transitionChunk(m, 0, "probed", { compId: "comp-new" });
		expect(m.chunks[0].compId).toBe("comp-new");
		// chunk 1 failed at the full render (compId kept): retry re-renders
		m = transitionChunk(m, 1, "probed", { compId: "comp-1" });
		m = transitionChunk(m, 1, "failed", { error: "render boom" });
		expect(m.chunks[1].compId).toBe("comp-1");
		m = transitionChunk(m, 1, "rendered");
		expect(m.chunks[1].state).toBe("rendered");
		expect(m.chunks[1].error).toBeUndefined();
	});

	test("markApproved persists the probe approval on the run", () => {
		const m = markApproved(manifest(1));
		expect(m.approved).toBe(true);
	});

	test("transitionChunk never mutates the input manifest", () => {
		const m = manifest(1);
		const next = transitionChunk(m, 0, "probed", { compId: "c" });
		expect(m.chunks[0].state).toBe("pending");
		expect(next.chunks[0].state).toBe("probed");
	});
});

describe("matchReusableChunks - re-run reuse", () => {
	test("rendered chunks with matching geometry + compId are reusable", () => {
		let m = manifest(3);
		m = transitionChunk(m, 0, "probed", { compId: "c0" });
		m = transitionChunk(m, 0, "rendered");
		m = transitionChunk(m, 1, "probed", { compId: "c1" }); // only probed: not reusable
		// chunk 2 stays pending
		const plan = [
			{ index: 0, startSec: 0, endSec: 90 },
			{ index: 1, startSec: 90, endSec: 180 },
			{ index: 2, startSec: 180, endSec: 270 },
		];
		const reusable = matchReusableChunks(m, plan);
		expect([...reusable.keys()]).toEqual([0]);
		expect(reusable.get(0)?.compId).toBe("c0");
	});

	test("geometry drift beyond the epsilon is not reused", () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "probed", { compId: "c0" });
		m = transitionChunk(m, 0, "rendered");
		const drifted = matchReusableChunks(m, [
			{ index: 0, startSec: 0, endSec: 95 },
		]);
		expect(drifted.size).toBe(0);
		const within = matchReusableChunks(m, [
			{ index: 0, startSec: 0.1, endSec: 90.2 },
		]);
		expect(within.size).toBe(1);
	});
});

describe("revalidateManifest - disk state downgrades", () => {
	test("rendered + missing comp dir -> pending with compId dropped", () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "probed", { compId: "gone" });
		m = transitionChunk(m, 0, "rendered");
		const { manifest: fixed, changed } = revalidateManifest(m, () => "missing");
		expect(changed).toBe(true);
		expect(fixed.chunks[0].state).toBe("pending");
		expect(fixed.chunks[0].compId).toBeUndefined();
	});

	test("rendered + stale render -> probed (re-render, approval holds)", () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "probed", { compId: "c" });
		m = transitionChunk(m, 0, "rendered");
		const { manifest: fixed } = revalidateManifest(m, () => "stale");
		expect(fixed.chunks[0].state).toBe("probed");
		expect(fixed.chunks[0].compId).toBe("c");
	});

	test("valid comp dirs leave the manifest untouched", () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "probed", { compId: "c" });
		m = transitionChunk(m, 0, "rendered");
		const { manifest: fixed, changed } = revalidateManifest(m, () => "valid");
		expect(changed).toBe(false);
		expect(fixed).toBe(m);
	});
});

describe("run-manifest-store - persistence round-trip", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "hf-manifest-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("save + load round-trips; unknown runIds load null", async () => {
		const m = manifest(2);
		await saveRunManifest(m, root);
		expect(await loadRunManifest("run-test", root)).toEqual(m);
		expect(await loadRunManifest("run-nope", root)).toBeNull();
	});

	test("invalid runIds are rejected, never touch the disk", async () => {
		await expect(loadRunManifest("../escape", root)).rejects.toThrow(
			/Invalid runId/,
		);
	});

	test("compDirStatus: missing / stale / valid against a fake comp dir", async () => {
		const compDir = path.join(root, "comp-x");
		expect(compDirStatus("comp-x", root)).toBe("missing");
		await mkdir(compDir, { recursive: true });
		await writeFile(path.join(compDir, "index.html"), "<html/>", "utf8");
		// index.html but no out.webm -> stale (render missing)
		expect(compDirStatus("comp-x", root)).toBe("stale");
		// out.webm NEWER than the source -> valid
		await writeFile(path.join(compDir, "out.webm"), "v", "utf8");
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(path.join(compDir, "out.webm"), "vv", "utf8");
		expect(compDirStatus("comp-x", root)).toBe("valid");
	});

	test("loadRevalidatedManifest downgrades a rendered chunk whose comp dir vanished", async () => {
		let m = manifest(1);
		m = transitionChunk(m, 0, "probed", { compId: "gone" });
		m = transitionChunk(m, 0, "rendered");
		await saveRunManifest(m, root);
		const fixed = await loadRevalidatedManifest("run-test", root);
		expect(fixed?.chunks[0].state).toBe("pending");
		expect(fixed?.chunks[0].compId).toBeUndefined();
		// and the correction was persisted
		const reloaded = await loadRunManifest("run-test", root);
		expect(reloaded?.chunks[0].state).toBe("pending");
	});
});
