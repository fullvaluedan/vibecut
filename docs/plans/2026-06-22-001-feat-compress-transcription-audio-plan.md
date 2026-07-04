---
title: "feat: Compress cloud-transcription audio to stay under Groq's 100 MB cap"
type: feat
status: ready
date: 2026-06-22
branch: feat/director-importance
depth: standard
---

# feat: Compress cloud-transcription audio before upload

## Summary

The opt-in cloud-transcription backend (Groq) uploads the timeline audio as an
uncompressed WAV. The WAV is already 16 kHz mono, but that is still ~38 MB / 20 min,
so it crosses Groq's **100 MB upload cap at roughly 50 minutes** (and any future
higher-rate extraction would cross it far sooner). Compress the audio to a small
codec **in the browser, before upload**, using the **mediabunny** encoder that is
already a dependency — no new package. Encode to the first natively-encodable
codec (prefer **Opus**, fall back to **AAC/m4a**); if the browser can encode
neither, fall back to today's 16 kHz-mono WAV. A 16 kHz-mono Opus stream is a few
MB even for an hour of audio, so the cap stops being a practical limit.

Scope is **only** the cloud-transcription upload path. The in-browser Whisper path
is untouched (it consumes the raw samples, not the uploaded blob).

---

## Problem Frame

- **Where:** the cloud branch of `ensureTimelineTranscript` in
  `apps/web/src/features/transcription/transcript-cache.ts` POSTs the WAV from
  `extractTimelineAudio` (`apps/web/src/media/mediabunny.ts`) to
  `apps/web/src/app/api/transcribe/route.ts`, which forwards it to Groq via
  `transcribeWithGroq` (`apps/web/src/services/transcription/providers/groq.ts`).
- **The cap:** Groq `/audio/transcriptions` rejects uploads over 100 MB. WAV is
  uncompressed PCM, so long sources fail. Already flagged as a known limitation in
  `docs/TO-VERIFY.md` ("Long-source size note").
- **Why compression is safe:** Groq accepts mp3/m4a/opus/flac/wav, and the
  `verbose_json` response shape is codec-independent — `normalizeGroqVerboseJson`
  and everything downstream (`{ segments, words }`, the cache, the Director
  detectors) are unchanged regardless of the uploaded codec.
- **Constraint:** WebCodecs `AudioEncoder` (used in browsers and already by
  `apps/web/src/services/renderer/scene-exporter.ts` for AAC) can natively encode
  Opus and AAC but **not** MP3 — true MP3 would need a new wasm encoder. Opus/AAC
  are smaller, dependency-free, and Groq-accepted, so MP3 is intentionally not used.

---

## Key Technical Decisions

- **KTD-1 — Codec: Opus, fall back to AAC, fall back to WAV.** Pick the codec at
  runtime via mediabunny's `getFirstEncodableAudioCodec(["opus", "aac"])`. Prefer
  Opus (smallest, Ogg/WebM container); use AAC/m4a (MP4 container) when Opus isn't
  encodable; if neither is encodable, return `null` and the caller uploads the
  existing 16 kHz-mono WAV. MP3 is rejected — not natively encodable, no smaller
  than Opus, would add a dependency (user confirmed the dependency-free path).
- **KTD-2 — Encode in the browser, not the route.** Smaller upload over the wire,
  no server-side codec dependency (the Node route stays a thin proxy), and
  mediabunny + WebCodecs already run client-side. The route only gains a
  filename/extension passthrough so Groq detects the codec.
- **KTD-3 — Reuse mediabunny + the existing extraction.** `extractTimelineAudio`
  keeps producing the 16 kHz-mono WAV (the in-browser path still needs it). The new
  encoder decodes that WAV to an `AudioBuffer` (via `decodeAudioToFloat32` /
  `OfflineAudioContext`) and re-emits it through a mediabunny `Output` +
  `AudioBufferSource`. No change to `extractTimelineAudio` itself, so the
  in-browser path is provably unaffected.
- **KTD-4 — Low bitrate, 16 kHz mono.** Already mono (`NUM_CHANNELS = 1`); target
  ~24–32 kbps. STT only needs intelligible speech, so this is ample and keeps an
  hour of audio in the single-digit-MB range.
- **KTD-5 — Filename carries the codec.** Groq infers format from the upload
  filename extension. The client sends the encoded blob with the right name
  (`timeline.ogg` / `timeline.m4a` / `timeline.wav`); the route reads the uploaded
  `File`'s name and `transcribeWithGroq` uses it instead of the hardcoded
  `"timeline.wav"`.

---

## Implementation Units

### U1. Compact audio encoder helper (mediabunny, browser)

- **Goal:** Given the 16 kHz-mono WAV blob, return a compact compressed blob plus
  its filename/mime, or `null` when the browser can't encode a compressed codec.
- **Files:**
  - `apps/web/src/media/audio-encode.ts` (new)
  - `apps/web/src/media/__tests__/audio-encode.test.ts` (new)
- **Approach:**
  - `encodeAudioForUpload({ audioBlob }): Promise<{ blob: Blob; filename: string } | null>`.
  - Decode the WAV to an `AudioBuffer` (reuse `decodeAudioToFloat32` from
    `apps/web/src/media/audio.ts` + an `OfflineAudioContext`, or `decodeAudioData`).
  - `getFirstEncodableAudioCodec(["opus", "aac"])` → map to a mediabunny `Output`:
    Opus → `OggOutputFormat`; AAC → `Mp4OutputFormat`. Feed the buffer through an
    `AudioBufferSource` at ~24–32 kbps, 16 kHz mono. Return `{ blob, filename }`
    (`timeline.ogg` / `timeline.m4a`).
  - Return `null` when `getFirstEncodableAudioCodec` finds nothing OR encoding
    throws — the caller handles the WAV fallback. Never throw to the caller.
  - Keep the **codec → { container, filename, mimeType }** mapping a pure exported
    helper (`codecUpload(codec)`) so it is unit-testable without WebCodecs.
- **Patterns to follow:** the WebCodecs capability check in
  `apps/web/src/services/renderer/scene-exporter.ts` (`AudioEncoder.isConfigSupported`);
  mediabunny usage in `apps/web/src/media/mediabunny.ts`.
- **Test scenarios** (`audio-encode.test.ts`, bun — pure mapping only; the encode
  itself is WebCodecs/browser and goes to TO-VERIFY):
  - `codecUpload("opus")` → `{ filename: "timeline.ogg", mimeType: "audio/ogg" }`.
  - `codecUpload("aac")` → `{ filename ends ".m4a", mimeType: "audio/mp4" }`.
  - Codec preference order is opus-before-aac (assert the array passed to the
    selector, or a pure `pickCodec(available)` helper: `["aac","opus"] → "opus"`,
    `["aac"] → "aac"`, `[] → null`).
- **Verification:** `tsc` clean; the pure mapping/selection tests pass; the
  browser encode is exercised in U3's live check.

### U2. Use the encoder on the cloud path + thread the filename

- **Goal:** The cloud transcription branch uploads the compressed blob (WAV only as
  fallback), and Groq receives the correct format via the filename.
- **Dependencies:** U1.
- **Files:**
  - `apps/web/src/features/transcription/transcript-cache.ts` (modify — cloud branch)
  - `apps/web/src/app/api/transcribe/route.ts` (modify — read uploaded filename)
  - `apps/web/src/services/transcription/providers/groq.ts` (modify — use passed filename)
- **Approach:**
  - In the cloud branch, after `extractTimelineAudio`: `const encoded = await
    encodeAudioForUpload({ audioBlob })`; choose `encoded ?? { blob: audioBlob,
    filename: "timeline.wav" }`. `form.append("audio", blob, filename)`. Existing
    progress ticker and `abortable` wrapper unchanged. The decode+encode happens
    while the "Uploading audio…" / elapsed ticker is showing.
  - Route: `form.get("audio")` is a `File` — read `audio.name` (guard: fall back to
    `"timeline.wav"`) and pass it to `transcribeWithGroq({ ..., filename })`.
  - `transcribeWithGroq`: use the passed `filename` for the Groq `file` field
    (already a param — confirm the route supplies it instead of the hardcoded name).
- **Patterns to follow:** the existing cloud branch + `buildTranscribeHeaders` flow
  in `transcript-cache.ts`; the formData parse in `route.ts`.
- **Test scenarios:**
  - Route: posting a `File` named `timeline.ogg` (fake key, so it reaches Groq and
    401s) — assert the Groq error path still returns 500 and the upload was accepted
    (extends the existing curl-style checks; covered as a TO-VERIFY live check since
    the route hits the network).
  - `Covers` the existing TO-VERIFY "Cloud transcription e2e" — now with a
    compressed upload.
  - Integration (browser, TO-VERIFY): a long source that previously exceeded
    100 MB as WAV now uploads as a few-MB Opus/m4a and transcribes.
- **Verification:** `tsc` clean; no new eslint errors (stash-compare on the 3
  modified files); route still 401/400-validates; live e2e in U3.

### U3. Docs + live checks

- **Goal:** Record the behavior change and the live checks the human runs.
- **Files:** `docs/TO-VERIFY.md` (modify)
- **Approach:** Update the "Cloud transcription — Groq backend" section: the upload
  is now compressed (Opus→AAC→WAV), and the long-source 100 MB note becomes "no
  longer a practical cap; falls back to WAV only if the browser can't encode." Add a
  live check: a 60-min source transcribes via cloud without a size error; confirm
  the network upload is a small `.ogg`/`.m4a` (DevTools → Network); confirm a normal
  short clip still works; confirm WAV fallback path if forced.
- **Test expectation:** none — docs only.

---

## Scope Boundaries

**In scope:** compressing the cloud-transcription upload; codec selection with WAV
fallback; filename passthrough so Groq detects the format.

**Out of scope / non-goals:**
- The in-browser Whisper path (consumes raw samples, not the uploaded blob).
- Server-side / route-side encoding (rejected — KTD-2).
- MP3 specifically (rejected — KTD-1; not natively encodable, would add a dep).
- Changing `extractTimelineAudio`'s output (kept as the shared 16 kHz-mono WAV).

### Deferred to Follow-Up Work
- **Chunking very long sources** above Groq's *duration*/size limits (split into
  windowed uploads + stitch transcripts) — only needed if multi-hour sources become
  a real case; compression alone covers the realistic range.
- **Encode straight from the extraction `AudioBuffer`** (skip the WAV→decode
  round-trip) — a perf refinement; not worth coupling the shared extractor now.
- **Deepgram / AssemblyAI** providers (already a separate follow-up) inherit the
  compressed upload for free.

---

## Risks & Mitigations

- **WebCodecs encoder unavailable in a browser** → `getFirstEncodableAudioCodec`
  returns nothing → `encodeAudioForUpload` returns `null` → WAV fallback (today's
  behavior). No hard failure on the encode path.
- **Container/codec mismatch Groq rejects** → mitigated by using standard
  Ogg/Opus and MP4/AAC containers with matching extensions; the live check confirms
  Groq accepts the chosen output. If a container is rejected, the codec map (U1) is
  the single place to adjust.
- **Decode round-trip cost** on a long source → it runs once, off the critical
  edit path, under the existing progress ticker; acceptable. Deferred optimization
  noted above.

---

## Verification

- **Unit (bun):** the pure codec→filename/mime mapping and codec-preference
  selection in `audio-encode.ts` (U1).
- **Route:** the filename passthrough — an upload named `.ogg` reaches Groq (fake
  key → 500), confirming the route forwards the codec correctly (extends the
  existing route checks).
- **End-to-end (browser, :3001, needs a Groq key):** Settings → AI → Cloud
  transcription ON + key; run AI CUT on a **long** source that previously failed the
  WAV upload → it now uploads a small `.ogg`/`.m4a` (verify in DevTools → Network)
  and transcribes; a short clip still works; word-level Director cuts still appear.
- Add these as live checks to `docs/TO-VERIFY.md` (U3).
