# Run VibeCut with your own AI subscription

VibeCut never hosts your AI. You connect **your own** account, on **your**
machine, and it stays there — keys and logins are stored device-local only
(browser localStorage for keys, the provider CLI's own store for
subscriptions). Nothing goes into project files, exports, or any server.

## 1. One-time setup (~10 minutes)

Prerequisites:

- [Bun](https://bun.sh) (runs the app)
- [Docker Desktop](https://docker.com) (local database + cache)
- [Node 22+](https://nodejs.org) and [FFmpeg](https://ffmpeg.org)
  (only needed for AI-generated motion graphics renders)

Then:

```bash
git clone https://github.com/fullvaluedan/vibecut
cd vibecut
cp apps/web/.env.example apps/web/.env.local   # defaults are fine
docker compose up -d db redis serverless-redis-http
bun install
bun dev:web
```

Open http://localhost:3000. Done — the editor works fully without any AI
connection (editing, timeline, export are all local).

## 2. Connect your AI (Settings → AI, in the editor)

Pick the row that matches what you already pay for:

| You have | What to install | Then |
|---|---|---|
| **Claude Pro/Max** | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm i -g @anthropic-ai/claude-code`), sign in once | Settings → AI → pick "Claude subscription (Claude Code)". Done — no key. |
| **ChatGPT Plus/Pro/Team** | [Codex CLI](https://developers.openai.com/codex/cli) (`npm i -g @openai/codex`) | Settings → AI → pick ChatGPT (Codex CLI) → click **Connect** (runs `codex login`, browser sign-in). `codex` on the `feat/codex-chatgpt-login` branch — see note below. |
| **OpenAI API / Anthropic API** | nothing | Settings → AI → paste the key (Anthropic key field, or Custom mode with `https://api.openai.com/v1`). |
| **Local / self-hosted model** | Ollama, LM Studio, etc. | Settings → AI → Custom → base URL + model name, no key needed. |

Optional, independent of the above: a free [Groq](https://console.groq.com)
key makes transcription near-instant. Without it, transcription still runs
in your browser, just slower.

## 3. Check it worked

Settings → AI shows the connection status. If a run fails with an auth
message, the fix is always the same shape: run the provider's CLI login in a
terminal (`claude` or `codex`), or re-paste the key.

## Notes

- **Subscription modes run on the provider's own CLI** (Claude Code, Codex).
  That is the sanctioned way your subscription's compute powers a third-party
  app — there is no direct "sign in with ChatGPT/Claude" web OAuth for
  consumer subscriptions, by the providers' own rules.
- **ChatGPT (Codex CLI) mode is on the `feat/codex-chatgpt-login` branch**
  until merged to main.
- Sharing one copy among several people over a network: subscription logins
  are per-machine, so each person should run their own copy (or bring an API
  key instead).
- Everything else in the app (media, projects, transcription cache) already
  stays on your device.
