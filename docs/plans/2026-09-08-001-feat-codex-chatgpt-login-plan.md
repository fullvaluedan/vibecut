# Plan: ChatGPT login for AI (Codex CLI provider) + provider-flow cleanup

Date: 2026-09-08. Status: in progress on branch `feat/codex-chatgpt-login`.
Parent direction: Dan 2026-09-08 — "make it support chatgpt login for ai; the flow
should be seamless for users." Slots into roadmap T21.2 (provider abstraction) as
the third BYO connection alongside claude-code and Anthropic API key.

## 0. Verified facts this plan rests on

Codex CLI (verified against developers.openai.com/codex/cli/reference + the
non-interactive-mode guide, 2026-09-08):

- `codex exec [PROMPT]` runs non-interactive; final agent message goes to stdout,
  progress to stderr. `codex e` is an alias.
- `--output-schema <file>` validates/conforms the final response to a JSON Schema
  file. `-o/--output-last-message <file>` writes the final message to a file.
- Auth reuses saved CLI login; `codex login` opens the ChatGPT OAuth browser flow;
  `codex login status` exits 0 when credentials exist (automation-friendly).
- `CODEX_API_KEY` env provides per-run API-key auth (exec only) — the escape hatch
  for headless deployments where ChatGPT login is impossible.
- `--skip-git-repo-check` (cwd may not be a repo), `--ephemeral` (no session
  rollout files), `--sandbox read-only` (we only need text back), `-m` model
  override, `--color never` via NO_COLOR.
- Windows install is a `.cmd` shim → same spawn-through-shell + taskkill tree-kill
  pattern the claude-code path already solved (shouldTaskkillOnTimeout).

Repo seams (all verified by reading the code):

- `ClaudeAuth` discriminated union: `packages/hf-bridge/src/types.ts:51`
  (`claude-code | api-key | custom`). The type name is baked into ~15 imports;
  we extend it, not rename it.
- LLM dispatch: `planDispatch` (author.ts:349), multimodal dispatch
  (author.ts:998 — claude-code falls to text-only `degraded: true`),
  composition author branch (author-composition.ts:71).
- Client → server auth transport: `buildAiAuthHeaders` (store.ts) sets
  `x-framecut-auth-mode` + mode-specific headers; `resolveAiAuth`
  (features/ai-generate/resolve-ai-auth.ts) parses them on every one of the 18
  AI routes. **Its fall-through default returns claude-code for ANY unknown mode
  string** — a version-skew hazard this plan tightens.
- Settings UI: `AUTH_MODE_LABELS` + `AiConnectionSection` in
  features/ai-generate/components/ai-settings.tsx.
- Onboarding: /get-started provider cards (provider-status.ts + page.tsx);
  doctor (`packages/hf-bridge/src/doctor.ts`) probes claude CLI but has NO
  client consumer.
- Assistant route (app/api/assistant/edit/route.ts) is one-shot per turn (the
  client drives the tool loop by sending toolResults back) but HARD-REJECTS
  every non-API-key mode with "needs an Anthropic API key" — the single worst
  seamlessness break for subscription users. It is fixable for BOTH claude-code
  and codex with the same one-exec-per-turn pattern (schema-constrained JSON via
  CLI), because no server-side session state is needed.

## 1. Standing decisions (do not relitigate in this round)

1. "ChatGPT login" = Codex CLI subscription mode (`mode: "codex"`). No new
   "OpenAI API key" mode: `custom` already covers any OpenAI-compatible endpoint
   with a key; its settings copy will mention api.openai.com/v1 explicitly.
2. Device-local rule holds: codex mode stores NOTHING in the browser — creds
   live in the Codex CLI (`~/.codex/auth.json`). Best privacy story of all modes;
   say so in the UI copy.
3. One exec per AI request, same kill-leash semantics as claude-code (5 min,
   reject-then-taskkill on win32). No Codex SDK, no MCP, no server session.
4. Env override `FRAMECUT_CODEX` mirrors `FRAMECUT_CLAUDE`.
5. All new logic in `packages/hf-bridge/src/codex.ts` (pure, testable helpers) +
   thin dispatch hooks. No upstream-originated files are touched ⇒ no PATCHES.md
   entries expected.

## 2. Tasks

- **T1 hf-bridge core**: `codex.ts` with `resolveCodex()`, `codexLoginStatus()`
  (probe via `codex login status`), `buildCodexExecArgs()` (pure),
  `runCodexPrompt()` (schema file in temp, prompt via stdin, kill leash),
  `planViaCodex()`, `authorViaCodex()` (FORMAT_RULES + brief, schema `{html}`),
  `assistantTurnViaCodex()` (schema `{text, toolCalls[]}`). Parse stderr
  /login|logged in/i into a friendly "run `codex login`" hint.
- **T2 types + dispatch**: extend `ClaudeAuth` with
  `{ mode: "codex"; model?: string }`; wire `planDispatch`, the multimodal
  dispatch (codex degrades to text-only exactly like claude-code for now; image
  support via `-i` is a follow-up), and the author-composition branch.
- **T3 auth transport**: `resolveAiAuth` accepts `x-framecut-auth-mode: codex`
  (+ optional `x-framecut-codex-model`); unknown modes now return null (→ 401
  with a "check Settings → AI / update" message) instead of silently degrading
  to claude-code. `buildAiAuthHeaders` sends the new mode; store `AiAuthMode`
  union extended.
- **T4 settings UI**: label "ChatGPT (Codex CLI)"; codex panel with a live
  status probe (new GET `/api/ai/codex-status` → installed? signed in?) and a
  **Connect ChatGPT button** that launches `codex login` on the user's machine
  (opens the browser for the ChatGPT sign-in; the panel polls
  `codex login status` and flips to Connected when it exits 0) — the closest
  thing to an in-app login, zero terminal typing. Plain-language install hint
  when the CLI is missing. Optional model field. Status probe pattern mirrors
  `probeServerGroqKey` (cached, session-long, manual refresh button). Same
  connect-button treatment for the claude-code panel afterward, for symmetry.
- **T5 doctor**: add `codexCli` entry to `DoctorReport`; surface it wherever
  claudeCli is shown. (No client consumer exists today — that gap is documented
  in the improvements doc, not silently expanded here.)
- **T6 onboarding**: third provider card "OpenAI (ChatGPT)" on /get-started;
  `deriveCodexStatus` in provider-status.ts; card copy explains the one-time
  `codex login`; feature copy de-coupled from provider names ("plans edits" vs
  "Anthropic").
- **T7 assistant route**: replace the API-key-only wall. Dispatch by mode:
  `api-key` → existing Anthropic fetch; `claude-code` → one `claude -p
  --output-format json` per turn with the tool contract as schema-constrained
  JSON; `codex` → `assistantTurnViaCodex`. Same response shape
  `{text, toolCalls, question, questionOptions, stopReason, usage, model}` for
  all modes; client unchanged. `ask_user` flows through identically.
- **T8 tests**: pure-helper tests for buildCodexExecArgs/parse/login-status
  parsing (no real spawns, mirroring claude-cli-kill.test.ts style); route tests:
  codex mode reaches the assistant (200 path with mocked exec), unknown mode →
  401; assistant claude-code 400 test flipped to 200-with-exec-mock. `bun test`
  + `bunx tsc --noEmit` clean.
- **T9 docs**: improvements/UX audit doc (deliverable 2) + handoff note at the
  bottom of this file when done.

## 3. Non-goals this round

- Pure in-browser OAuth against ChatGPT accounts. OpenAI offers no consumer
  ChatGPT OAuth for third-party apps — the Codex CLI is the sanctioned channel
  for subscription compute (exactly why claude-code mode exists for Anthropic).
  The Connect button wraps the CLI's own login instead.
- Per-user ChatGPT subscriptions on a HOSTED deployment. CLI logins are
  per-machine, so a shared hosted copy cannot carry one subscription per user;
  hosted users bring an OpenAI API key (custom mode → api.openai.com/v1) or
  wait for the T21.3+ credit system. BYO-subscription is a local-copy feature.
- Codex `-i` image input for Director vision (capability matrix work, T21.2).
- Hosted/multiuser codex (CODEX_API_KEY on the server) — documented as the
  headless escape hatch only.
- Rate-limit/usage surfacing for subscription modes (CLI doesn't expose quota).

## 4. Result log (2026-09-08, branch feat/codex-chatgpt-login)

SHIPPED on the branch: T1–T8 complete. Codex core (`codex.ts`: exec args, run,
agent run, login status, hints), ClaudeAuth `codex` mode, planDispatch +
multimodal + composition-author dispatch, resolveAiAuth codex + strict unknown-
mode 401, store/headers codexModel, Settings panel with Connect ChatGPT button +
polling status probe (`/api/ai/codex-status` GET/POST login|status), doctor
codexCli entry, get-started OpenAI card, assistant route CLI-turn path
(cli-turn.ts + cli-llm.ts seam) un-walling claude-code AND codex, runbook doc.

Gates: apps/web **2701 pass / 0 fail** (was 2690), hf-bridge **219 pass / 0
fail**, `bunx tsc --noEmit` clean apart from PRE-EXISTING upstream errors
(src/changelog + src/app/changelog: `content-collections` codegen not run in
this environment — untouched by this branch).

DAN-OWED / deferred: live `codex exec` run (Codex CLI not installed on this
machine — mocked-spawn tests only, mirroring the claude-code round-17 posture);
Director vision images via `codex -i`; token usage for Codex mode (CLI doesn't
surface it without the --json stream); hosted/multiuser codex.
