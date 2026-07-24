import { describe, expect, test } from "bun:test";
import { shouldTaskkillOnTimeout } from "../author";

/**
 * D1: the claude-CLI kill timer's platform branch. On Windows the CLI is
 * spawned with `shell: true`, so the pid we get back is cmd.exe, not the real
 * claude/node process - a plain `child.kill()` only kills the wrapper and
 * orphans the process actually running the hung call. `shouldTaskkillOnTimeout`
 * is the pure decision of whether to walk the whole tree by pid (`taskkill`)
 * instead of the plain kill; the actual tree-kill (spawning taskkill and
 * having it reap the real process) is not exercised here - it needs a live
 * Windows process tree to verify, so it was checked by hand instead.
 */
describe("shouldTaskkillOnTimeout", () => {
	test("true on win32 with a pid", () => {
		expect(shouldTaskkillOnTimeout({ platform: "win32", pid: 1234 })).toBe(true);
	});

	test("false on win32 without a pid (spawn never got one)", () => {
		expect(shouldTaskkillOnTimeout({ platform: "win32", pid: undefined })).toBe(
			false,
		);
	});

	test("false on darwin even with a pid", () => {
		expect(shouldTaskkillOnTimeout({ platform: "darwin", pid: 1234 })).toBe(
			false,
		);
	});

	test("false on linux even with a pid", () => {
		expect(shouldTaskkillOnTimeout({ platform: "linux", pid: 1234 })).toBe(
			false,
		);
	});
});
