import { describe, expect, test } from "bun:test";
import {
	buildCodexExecArgs,
	codexAuthHint,
	codexMissingHint,
	resolveCodex,
} from "../codex";

/**
 * Pure-branch tests for the Codex CLI (ChatGPT login) backend — same style as
 * claude-cli-kill.test.ts: no live spawns. The spawn/kill behaviour itself is
 * exercised by the runCodexPrompt integration path and was hand-checked.
 */
describe("buildCodexExecArgs", () => {
	test("read-only, ephemeral, no git check, stdin sentinel", () => {
		const args = buildCodexExecArgs({ outputPath: "out.txt" });
		expect(args).toContain("exec");
		expect(args).toContain("--sandbox");
		expect(args).toContain("read-only");
		expect(args).toContain("--skip-git-repo-check");
		expect(args).toContain("--ephemeral");
		expect(args[args.length - 1]).toBe("-");
	});

	test("output-last-message is wired", () => {
		const args = buildCodexExecArgs({ outputPath: "out.txt" });
		const i = args.indexOf("--output-last-message");
		expect(i).toBeGreaterThanOrEqual(0);
		expect(args[i + 1]).toBe("out.txt");
	});

	test("schema flag only when a schema is given", () => {
		expect(buildCodexExecArgs({ outputPath: "o" })).not.toContain(
			"--output-schema",
		);
		const withSchema = buildCodexExecArgs({
			outputPath: "o",
			schemaPath: "s.json",
		});
		const i = withSchema.indexOf("--output-schema");
		expect(withSchema[i + 1]).toBe("s.json");
	});

	test("model flag only when a model is given", () => {
		expect(buildCodexExecArgs({ outputPath: "o" })).not.toContain("-m");
		const withModel = buildCodexExecArgs({
			outputPath: "o",
			model: "gpt-5.1-codex",
		});
		const i = withModel.indexOf("-m");
		expect(withModel[i + 1]).toBe("gpt-5.1-codex");
	});
});

describe("codexAuthHint / codexMissingHint", () => {
	test("auth hint on login-required stderr", () => {
		expect(codexAuthHint("error: Not logged in, run codex login")).toContain(
			"codex login",
		);
		expect(codexAuthHint("401 unauthorized")).toContain("codex login");
	});

	test("no auth hint on unrelated errors", () => {
		expect(codexAuthHint("network unreachable")).toBe("");
		expect(codexAuthHint("")).toBe("");
	});

	test("missing-binary hint on ENOENT-style errors", () => {
		expect(codexMissingHint("'codex' is not recognized")).toContain(
			"@openai/codex",
		);
		expect(codexMissingHint("spawn codex ENOENT")).toContain(
			"FRAMECUT_CODEX",
		);
		expect(codexMissingHint("exit 1: bad schema")).toBe("");
	});
});

describe("resolveCodex", () => {
	test("default is the bare command through the shell", () => {
		const saved = process.env.FRAMECUT_CODEX;
		delete process.env.FRAMECUT_CODEX;
		try {
			expect(resolveCodex()).toEqual({ command: "codex", useShell: true });
		} finally {
			if (saved !== undefined) process.env.FRAMECUT_CODEX = saved;
		}
	});

	test("FRAMECUT_CODEX override runs without the shell", () => {
		const saved = process.env.FRAMECUT_CODEX;
		process.env.FRAMECUT_CODEX = "C:/tools/codex.exe";
		try {
			expect(resolveCodex()).toEqual({
				command: "C:/tools/codex.exe",
				useShell: false,
			});
		} finally {
			if (saved === undefined) delete process.env.FRAMECUT_CODEX;
			else process.env.FRAMECUT_CODEX = saved;
		}
	});
});
