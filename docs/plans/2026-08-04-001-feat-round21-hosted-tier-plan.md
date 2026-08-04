# Round 21 plan: hosted tier (accounts + credit ledger, billing + shop, metering, licensing)

Date: 2026-08-04. Author: Fable (planning only). Parent: roadmap
`docs/plans/2026-08-01-001-feat-capcut-parity-roadmap.md` section 10 (T21.3-T21.7)
and section 11 (the pricing knobs that are Dan's call).
Research base: a 2026-08-04 terrain map of the auth layer, the Postgres/drizzle
schema, and every compute-spending API route, plus the round 20 close and the
T21.2 provider abstraction (tip `1c5be702`). Dan's direction is FIXED by the
roadmap: this plan starts from decisions, not debate. No implementation has
started; the pricing knobs in section 4 are Dan's call before T21.3 opens.

## 0. Preconditions reviewed (the terrain the plan builds on)

1. **better-auth is wired but has no UI.** `apps/web/src/auth/server.ts` configures
   betterAuth with the drizzle Postgres adapter, email+password, and Upstash Redis
   rate limiting; `apps/web/src/auth/client.ts` exports `signIn`/`signUp`/`useSession`
   but nothing in the UI calls them. The `users`/`sessions`/`accounts`/`verifications`
   tables exist with `enableRLS()`. Decision ground for T21.3: REUSE this layer and
   extend it, do not replace it. The roadmap explicitly leaves reuse-vs-replace to
   this plan; the answer is reuse, because the schema, adapter, rate limiting, and
   route handler are already in place and the only missing piece is UI + policies.
2. **Postgres + drizzle migrations exist but the config is stale.** `drizzle.config.ts`
   points at `./src/lib/db/schema.ts`, while the real schema lives at
   `./src/db/schema.ts`. One migration exists (`apps/web/migrations/0000_brainy_saracen.sql`).
   T21.3 must fix the config path and prove `db:generate` + `db:migrate` against a
   scratch database BEFORE adding billing tables, or the first migration lands on a
   broken pipeline.
3. **Every compute route resolves AI auth from headers via `resolveAiAuth`.**
   Compute routes today: `/api/transcribe`, `/api/assistant`, `/api/assistant/edit`,
   `/api/director/{plan,assemble,context,redundancy,retake,structural,verify}`, and
   `/api/hyperframes/{author,plan,render,render-comp,bake,studio,...}`. Hosted mode
   means an authenticated request resolves to OUR server-side keys instead of
   device headers; BYO mode means today's header path, untouched and un-metered.
4. **The provider layer already returns normalized usage on every transport.**
   `packages/hf-bridge/src/llm-client.ts` normalizes `{inputTokens, outputTokens}`
   for Anthropic, every OpenAI-compatible provider, and the claude-code CLI, and
   every route already threads `usage` back to the client. That is the metering
   seam: capture usage server-side, compute credits from the rate table, debit.
   Transcription is the exception: `/api/transcribe` returns no usage, so metering
   there uses audio duration, which the server must receive (add `durationSec` to
   the form; the client knows the timeline audio duration).
5. **The U3 run ledger is NOT a billing ledger.** `run-ledger.ts` records per-run
   Director taste signals (proposed/accepted/reversed counts per category) on the
   project. It is still useful for T21.5 calibration (run counts per project), but
   the shadow-metering ledger (per-route usage + credits + estimated raw cost) is a
   new, server-side record.
6. **No Stripe dependency, no billing tables, no /account page, and the legal pages
   are OpenCut's.** Verified: `/privacy` and `/terms` metadata and copy still say
   OpenCut, and their "your content never leaves your device" claim becomes false
   in hosted mode (footage is sent to OUR providers). T21.6 rewrites them before
   any money is charged.
7. **Server env today:** `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`/`TOKEN`,
   `BETTER_AUTH_SECRET`, `GROQ_API_KEY` are in `apps/web/.env.local`.
   `ANTHROPIC_API_KEY` is read by the assistant edit route but NOT set anywhere, so
   hosted Director/assistant/hyperframes calls need it added to `env.example` and
   the deploy config.
8. **Deployment:** the web app builds for Cloudflare via opennextjs-cloudflare
   (`wrangler.jsonc`), with a Dockerfile for self-hosting and external Postgres.
   The monthly grant needs a platform cron (wrangler cron on the Cloudflare deploy,
   or a scheduled Next route elsewhere); Stripe webhooks need a normal route handler
   with signature verification.

## 1. Standing decisions (agents do not relitigate)

Fixed direction from the roadmap, stated here so the round starts from decisions:

1. **Two offers, one codebase.** (a) BYO keys: device-local, never sent to our
   server, metering bypassed entirely. (b) Hosted tier: our provider keys,
   metered credits, $20/month "Pro" including 1,000 credits ($10 face value),
   refreshed monthly, no rollover (recommended default; Dan knob, section 4).
2. **Reuse better-auth** for accounts (decision 1 above): same adapter, same
   Postgres schema extended with billing tables, new sign-in/up UI only.
3. **The credit ledger is append-only Postgres** with immutable transaction rows:
   types `grant`, `topup`, `hold`, `spend`, `refund`. Balance is a cached column
   recomputed from the transaction sum under a row lock; history is never mutated.
4. **Metered rates embed ~2x raw provider cost** (roadmap T21.5 items 2-4 are the
   launch defaults): 1 credit = $0.01 face value; transcription ~8 credits/audio-
   hour; a full Director multi-pass on a 30-minute project ~300-400 credits; an
   assistant turn ~5-10 credits. Top-up packs: 500/$5, 1,050/$10 (5% bonus),
   2,750/$25 (10% bonus), 6,000/$50 (20% bonus). All numbers are server-side
   config, tunable without a release.
5. **Metering scope.** The roadmap enumerates `/api/transcribe`, `/api/director/*`,
   `/api/assistant/*`. This plan EXTENDS the same middleware to
   `/api/hyperframes/author` and `/api/hyperframes/plan`, because those are provider
   LLM spend through the same normalized-usage seam; rendering routes stay
   un-metered in v1 (local engine CPU, no provider cost). Flagged for Dan in
   section 4: if he wants renders metered too, that is a small addition (meter by
   render duration), not a redesign.
6. **Guardrails are launch requirements, not options** (roadmap T21.5 item 5):
   per-user daily spend cap default 500 credits (raisable in settings); per-op cost
   preview for anything estimated over 100 credits; Haiku-class model routing for
   cheap passes exactly as the Director already does; per-provider kill switch.
7. **Graceful zero-balance handling** (roadmap T21.3): hard-stop with a top-up
   prompt at zero BEFORE an op starts; for an op already in flight, the hold covers
   it, it finishes, and settle-then-prompt happens after. Holds expire on a TTL so a
   crashed run never leaks credits.
8. **Stripe test mode for all verification**; regional pricing and annual plans are
   OUT of scope for v1.
9. **Process contract for every task** (unchanged): branch from `feat/director-eval`,
   verify the worktree base by test count BEFORE starting (baseline at tip
   `1c5be702`: apps/web 2804 pass / 0 fail / 1 skip, hf-bridge 253 pass / 0 fail),
   no em dashes in added lines, PATCHES.md row in the SAME commit for any
   upstream-originated file, marker-grep before commit AND push, stage explicit
   paths (never `git add -A` - it sweeps the local-only `.claude/` and
   `bunfig.toml`).

## 2. Tasks

Gates for every task: G1 `bun test` apps/web at baseline+ and hf-bridge, G2
`bunx tsc --noEmit` from apps/web, G3 new tests for the changed area, G4 hands-on
browser check where the task says, and the round closes with T21.7's end-to-end
pass + G6 ratings (9/9 per feature or reopen).

### T21.3 Hosted tier: accounts + credit ledger + metering (CRITICAL PATH)
Agent: **Opus**. Size: L-XL. Worktree: yes. Everything in the round depends on this.

1. ACCOUNTS UI: a minimal sign-in/sign-up page set (email + password via the
   existing better-auth client), server-side session helpers on every metered
   route (`auth.api.getSession`), a sign-out action, and a small profile surface in
   Settings showing the signed-in account and plan. No social login in v1.
2. SCHEMA + MIGRATION: fix the `drizzle.config.ts` schema path first and prove the
   migration workflow against a scratch database; then add the billing tables:
   `credit_transactions` (append-only; id, user_id, type, credits signed, balance_after,
   route/feature, reference, meta, created_at), `balances` (user_id, balance,
   monthly_grant_cycle), `user_settings` (daily_spend_cap), and the Stripe customer
   mapping for T21.4. Enable RLS on every new table and write the policies (the
   auth tables call `enableRLS()` but policies still need to exist; confirm what
   the existing migration actually created before assuming it).
3. LEDGER SERVICE: `applyCreditTransaction` under a Postgres row lock (SELECT ...
   FOR UPDATE on the balance row; advisory lock as the documented alternative),
   balance recomputed from the signed sum, holds auto-expiring (explicit release
   on settle, TTL fallback), one function per transaction type. Pure math split out
   for unit tests, mirroring the `run-ledger.ts` precedent.
4. HOSTED-MODE RESOLUTION: extend `resolveAiAuth` (or wrap it) so an authenticated
   request with an active hosted subscription resolves to server-side keys
   (`ANTHROPIC_API_KEY` for Director/assistant/hyperframes LLM, `GROQ_API_KEY` for
   transcription), and the client learns metering is ON (balance + plan in the
   response/headers). BYO requests keep today's header resolution byte-for-byte;
   the eval disk cache keys on the header contract, so hosted mode must be a NEW
   mode, never a mutation of existing ones.
5. METERING HELPER: a route-level wrapper (NOT edge middleware - Postgres is not
   reachable from the edge), applied to `/api/transcribe`, `/api/assistant`,
   `/api/assistant/edit`, `/api/director/*`, `/api/hyperframes/author`,
   `/api/hyperframes/plan`. Behavior per request: resolve mode; BYO = pass-through
   with zero ledger writes; hosted = check balance, hard-stop 402 with a top-up
   prompt at zero, place a hold for the estimated cost, run, read the normalized
   usage, settle actual spend, release the hold difference, return the new balance.
   Mid-run hard-stop rule: never abort an in-flight op; settle then prompt.
6. TRANSCRIBE METERING: client sends `durationSec` (timeline audio duration) with
   the form; server clamps to a sane bound (e.g. 6h) and rejects nonsense; credits
   computed from the rate table (~8 credits/audio-hour default).
7. MONTHLY GRANT JOB: a scheduled, secret-guarded route (wrangler cron for the
   Cloudflare deploy, documented alternative for self-host) that grants 1,000
   credits once per billing cycle to active subscribers. Idempotency key = user +
   cycle, so double runs never double-grant.
8. TESTS (G3): append-only ledger invariant (no mutation, no negative balance via
   refunds), balance math with holds, hold TTL expiry, concurrent debit
   serialization, BYO bypass produces zero rows, hosted hard-stop 402, in-flight
   settle-then-prompt, grant idempotency, metering on every route with fixture
   usage, RLS policies reject cross-user reads.

### T21.4 Billing + shop
Agent: **Opus** (Stripe server side) + **Sonnet** (UI). Size: M-L. Worktree: yes;
rebases on T21.3.

1. STRIPE (server): add the `stripe` dependency (server-side only), checkout
   sessions for the $20/month Pro subscription and for one-time top-up packs, and
   `/api/stripe/webhook` with signature verification and idempotency (Stripe
   `Idempotency-Key` or a processed-events table). `checkout.session.completed` and
   `invoice.paid` write ledger rows through the T21.3 ledger service. Cancel /
   subscription-unchanged flows produce no ledger writes.
2. SHOP UI: the four top-up packs from section 1 with their bonus tiers, prices
   from server config, one-click checkout, and a receipt/confirmation state.
3. /ACCOUNT PAGE: balance (credits + face value), usage history by feature (ledger
   query grouped by route/feature with date ranges), invoices list (from Stripe),
   plan management (subscribe / cancel / change plan), and the shop. The page is
   the hosted-tier home; link it from the header avatar and Settings.
4. ENV: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO_MONTHLY`,
   `STRIPE_TEST_MODE=true` for verification; add to `env.example` and the deploy
   config, never committed with real values.
5. TESTS (G3): webhook signature verification (valid/invalid/malformed),
   idempotent replay, checkout completion credits the ledger, cancel writes
   nothing, usage-history query shape, shop pack math (bonus tiers exactly the
   roadmap numbers). G4: Stripe test-mode run in a fresh browser profile -
   subscribe, see 1,000 credits, buy a top-up, watch the balance math land.

### T21.5 Pricing config + cost guardrails
Agent: **Opus**. Size: M. Worktree: yes; rebases on T21.3.

1. PRICE TABLE: a single server-side config (route -> credit formula + provider
   rate table for shadow cost) carrying the section-1 defaults verbatim; validated
   at boot (a bad table fails fast, never meters at zero or negative).
2. COST PREVIEW: a pure estimator shared client/server (transcribe: duration;
   assistant: flat per turn; Director: duration/segment heuristics against the
   multi-pass pipeline; hyperframes: prompt size + render scope). Any estimate over
   100 credits forces the client confirm ("This Director run will use ~350 credits.
   Continue?") before the call; the estimator is the same function the metering
   helper uses for the hold, so preview and hold can never disagree.
3. DAILY SPEND CAP: default 500 credits, stored per-user (`user_settings`),
   editable in the account page, enforced in the metering helper. A Redis daily
   counter is the fast path (matches the existing rate-limit pattern); the Postgres
   ledger is the source of truth and reconciles the counter on write.
4. KILL SWITCH: per-provider env flags (e.g. `HOSTED_DISABLE_ANTHROPIC`,
   `HOSTED_DISABLE_GROQ`); a disabled provider fails closed with a clear message in
   the metered routes, never silently rerouting to another provider.
5. SHADOW METERING: a config flag that records usage + computed credits + estimated
   raw cost for every op WITHOUT debiting (the ledger rows land with a `shadow`
   marker). Purpose: calibrate the 2x factor per route BEFORE launch using the
   four-fixture eval + three real projects, comparing metered credits against
   actual provider invoices (Dan provides the invoice/usage numbers). Shadow mode
   must be provably zero-debit (test asserts it).
6. TESTS (G3): estimator math vs the rate table, cap enforcement at the boundary,
   kill-switch fail-closed, price-table validation, shadow-mode zero-debit
   invariant, preview == hold amount.

### T21.6 Licensing + packaging checklist for selling
Agent: **Haiku**. Size: S. Worktree: yes. Fully parallel with T21.3 (disjoint files).

1. AUDIT: keep the MIT attribution intact in the product and site (already partially
   done for masks; verify the footer/OG/brand surfaces). Audit dependencies for
   commercial-hosting compatibility, explicitly the HyperFrames npm terms; record
   the result, and if anything blocks commercial hosting, flag it to Dan BEFORE
   launch rather than burying it.
2. THIRD-PARTY-LICENSES: a page (new route) sourced from the existing
   `THIRD_PARTY_NOTICES.md` content, extended where the audit finds gaps.
3. LEGAL PAGES: rewrite `/privacy` and `/terms` for VibeCut (they are currently
   OpenCut's, including the "your content never leaves your device" claim, which is
   true in BYO mode but false in hosted mode - the copy must state exactly what is
   sent to which provider in each mode).
4. TESTS (G3): license page renders from the notices data, terms/privacy contain no
   OpenCut references, hosted-mode data-flow copy present.

### T21.7 Round 21 verification + G6
Agent: **Sonnet**. Size: M. Last; everything must merge first.

1. Regression gates at the merge tip (G1 both suites, G2 tsc, marker-grep clean).
2. E2E in a FRESH browser profile (Stripe test mode): onboard; BYO key flow works
   and produces ZERO ledger rows; then hosted flow: sign up, subscribe, see 1,000
   credits, run a metered Director pass, watch the balance drop by the previewed
   amount, hit the daily cap, buy a top-up, and verify the ledger reconciles to the
   penny (transactions sum == displayed balance, grant cycle correct, no rollover).
3. G6 score each feature 1-10 func/qual with evidence (screenshots, the G4
   transcript, Stripe test-mode receipts); anything under 9 reopens its task.

## 3. Sequencing and parallelism

Wave 1: T21.3 (Opus, critical path) and T21.6 (Haiku, disjoint files) run in
parallel worktrees.
Wave 2: T21.4 (Opus + Sonnet) and T21.5 (Opus) once T21.3 merges; both rebase on
T21.3 and touch the ledger/metering files, so merge T21.5 first (smaller) then
T21.4, or run them against T21.3 and rebase in either order - the round brief
records the chosen order.
Wave 3: T21.7 verification + G6.

Estimate: ~10-14 agent-days wall-clock with that parallelism (the roadmap's 2-3
weeks is calendar time including Dan's loops; the code is this). T21.3 alone is
roughly 5-7 agent-days.

## 4. Dan-owed / open (before T21.3 opens)

The roadmap section-11 pricing knobs are Dan's call; the recommended default is
listed first, and the plan proceeds with it if he does not object:

1. **Monthly credit rollover**: no-rollover (recommended - the biggest margin leak
   in credit systems; revisit only if churn data demands it) vs a rollover cap.
2. **xAI Grok in the provider list at launch**: T21.2 already ships xai-grok with
   the "community quality" label, so this knob is now "keep it visible" (current
   state) vs "hide it until it passes the four-fixture eval".
3. **Free-trial shape**: BYO mode IS the free tier (recommended - no separate trial
   credits at launch) vs trial credits.
4. **Metering scope extension** (this plan's one addition beyond the roadmap
   enumeration): meter hyperframes author/plan LLM calls in hosted mode; renders
   stay un-metered in v1. Confirm or amend.
5. **Stripe test-mode keys + a Pro price id** for T21.4/T21.7 live verification
   (agent can use Stripe's test defaults until then, but the webhook needs a
   reachable endpoint in the dev environment).
6. **Server-side `ANTHROPIC_API_KEY`** for hosted Director/assistant/hyperframes
   (not present in `.env.local` today; must be added to the deploy config).
7. Carried from rounds 19/20: real-footage feel checks and the transcript content
   check in a real browser (headless Chrome has no AudioDecoder); they do not block
   this round's build but are part of final acceptance.

## 5. Status

PLAN ONLY, awaiting Dan's approval of section 4 and the pricing knobs. No
implementation has started. When approved, T21.3 and T21.6 open as worktree tasks
per section 3, each verifying its base by test count first.
