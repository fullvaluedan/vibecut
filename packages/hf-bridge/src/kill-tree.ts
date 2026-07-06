import { spawn } from "node:child_process";

/**
 * Force-kill a spawned child AND its descendants. A plain child.kill() leaves
 * grandchildren alive — exactly the processes that matter here (`claude -p`
 * spawns node -> the CLI; hyperframes render spawns headless Chromium):
 *  - win32: `taskkill /pid <pid> /t /f` walks the tree.
 *  - posix: callers should spawn with `detached: true` (own process group /
 *    pid), so a negative pid signals the whole group in one shot.
 * Both fall back to a plain kill if the tree kill can't be issued.
 */
export function killTree(child: ReturnType<typeof spawn>): void {
	const pid = child.pid;
	if (pid == null) return;
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
}
