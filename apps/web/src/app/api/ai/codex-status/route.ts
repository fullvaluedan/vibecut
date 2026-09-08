import { NextResponse } from "next/server";
import { codexLoginStatus } from "@framecut/hf-bridge";

export const runtime = "nodejs";

/**
 * GET /api/ai/codex-status — is the Codex CLI installed, and signed in?
 *
 * POST /api/ai/codex-status — two actions:
 *  - { action: "status" }: read-only re-probe (the Connect panel polls this
 *    while the user is signing in — never launches a login).
 *  - { action: "login" }: start `codex login` on the server machine. The CLI
 *    opens the user's default browser for the ChatGPT OAuth flow. Spawned
 *    detached and unref'd so the login process survives this request's end;
 *    completion is detected by polling { action: "status" }, not by waiting
 *    on the child (the CLI keeps its login flow alive independently).
 */
export async function GET() {
	const status = await codexLoginStatus();
	return NextResponse.json(status);
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as
		| { action?: string }
		| null;
	if (body?.action === "login") {
		const { spawn } = await import("node:child_process");
		const { resolveCodex } = await import("@framecut/hf-bridge");
		const { command, useShell } = resolveCodex();
		try {
			const child = spawn(command, ["login"], {
				shell: useShell,
				detached: true,
				stdio: "ignore",
				env: { ...process.env, NO_COLOR: "1" },
			});
			child.on("error", () => {}); // probe surfaces "not installed"
			child.unref();
			return NextResponse.json({ started: true });
		} catch {
			return NextResponse.json(
				{ error: "Could not start the Codex CLI login." },
				{ status: 500 },
			);
		}
	}
	// Default (and { action: "status" }): read-only probe.
	const status = await codexLoginStatus();
	return NextResponse.json(status);
}
