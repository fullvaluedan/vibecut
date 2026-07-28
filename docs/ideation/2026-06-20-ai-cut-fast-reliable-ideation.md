# Ideation — making AI CUT fast, reliable, and better at repeats/dead-time

Created: 2026-06-20 · Repo-grounded · Subject: the AI Director / AI CUT pipeline (transcription → silence/repeat/filler/dead-air detection → LLM plan → review). Focus: repeats, unnecessary/dead footage, context relevance, speed, reliability + prior art on GitHub.

This is an **ideation** artifact (ranked directions worth exploring), not a plan. Pick one → `/ce-brainstorm` to scope it.

---

## The reframe (read first)

This session shipped a **degrade**: when the default `onnx-community/whisper-small` can't emit cross-attention word timestamps, we fall back to segment-level and the word-level detectors (duplicate-words, filler, dead-air, phrase-repeat) go dark. The external research shows that was a **model-choice** problem, not a hard capability limit: the **`_timestamped` ONNX whisper exports** (`onnx-community/whisper-base_timestamped`, `whisper-medium.en_timestamped`) *do* support `return_timestamps:"word"` in transformers.js. So the highest-leverage move isn't more detectors — it's getting word timestamps back, which re-arms the detectors we already built. The degrade stays as a safety net.

---

## Survivors (ranked)

### S1 — Switch to a `_timestamped` Whisper export → re-arm the word-level detectors  ⭐ top
The original "3 repeats at the start" + filler/dead-air gaps exist because words are off. Using a `_timestamped` model restores `phrase-repeat`, `duplicate-words`, `filler-words`, `dead-air` — all already built and tested. `whisper-base_timestamped` is small (good for long video). 
- **Borrow:** `onnx-community/whisper-base_timestamped` / `medium.en_timestamped`.
- **Risk:** verify word timestamps actually work in our transformers.js version (the `large-v3-turbo_timestamped` export was broken, fixed in transformers.js PR #1594; base/medium.en are the safe bets). Probe (U1, shipped) makes the swap safe — if a chosen model can't do words, we still degrade.
- **Why now:** turns 5 dormant detectors back on for a one-line model change + a probe we already have.

### S2 — Silero VAD pre-filter before Whisper  ⭐ top
Run a 2 MB VAD (MIT, browser-ready via `vad-web`/ONNX Runtime Web) to extract **speech intervals**, transcribe only those. Hits four of our problems at once:
- **Speed:** 30–50% of a 15-min recording is non-speech → that much less Whisper compute.
- **OOM/reliability:** less audio fed to Whisper; also kills Whisper's silence-hallucination.
- **Dead-time, for free:** the VAD's non-speech spans ARE the "just sitting there / long pause" the text Director can't see — feed long non-speech gaps straight in as cut candidates (catches stuff above the dB silence threshold, e.g. ambient room tone while drinking water).
- **Borrow:** `snakers4/silero-vad`, `ocavue/vad-web`. **Risk:** another worker + model download; integrate ahead of `decodeAudioToFloat32`.

### S3 — Deterministic dead-time detection (audio VAD + cheap visual)  ⭐ top — directly fixes "me just sitting there"
Two cheap signals, no LLM/API needed (works offline, unlike Vision v0 which needs api-key mode):
- **Audio:** long VAD non-speech spans (from S2) → dead-air cut candidates.
- **Visual:** sample ~1 frame/s → canvas pixel-diff for frozen/low-motion (>2 s under ~1% delta), + MediaPipe face detector for "off-screen". Flag as cut candidates with a "dead time" badge.
- **Borrow:** `PySceneDetect` (HashDetector idea), MediaPipe Face Detector (browser WASM), plain canvas frame-diff. **Why:** this is the structural answer to silent low-value footage that transcript-only directing is blind to — and it's deterministic + free, complementing the (api-key-only, per-segment) Vision pass.

### S4 — MiniLM embedding repeat detection (paraphrase-aware)  ◆ high
Our shipped `segment-repeat` is lexical/verbatim only. `Xenova/all-MiniLM-L6-v2` (80 MB, browser ONNX) cosine-compares segment embeddings to catch **paraphrased** restatements ("same point, different words") the LLM currently misses. Two-pass: our lexical pre-filter first (free), embeddings only on near-misses.
- **Borrow:** `Xenova/all-MiniLM-L6-v2`. **Risk:** model download; the LLM already attempts paraphrase — measure incremental catch before committing the 80 MB.

### S5 — Low-confidence-word cut candidates  ○ medium (rides on S1)
The `_timestamped`/DTW models also give per-word confidence. Flag very-low-confidence words (often mumbles/false starts the filler list misses) as review candidates. Cheap add-on once S1 lands.

---

## Rejected (with reasons)

- **Server-side faster-whisper offload** (4× + batched VAD, <60 s for 15 min). Strong, but requires GPU server infra and breaks the local-first/in-browser identity. Revisit only if in-browser proves unworkable for very long sources.
- **Audio prosody/energy as importance signal.** Already have it (`computeSpeechFeatures` + `importance.ts` emphasis/rate/loudness).
- **Margin-padding / EDL approach (auto-editor).** Already have padding (`remove-silences` PADDING_SEC, `pacing` target-gap).
- **Chunked whisper decode (`chunk_length_s`/`stride`).** Already done — we pass `chunk_length_s=30, stride=5`; the OOM was audio *extraction*, fixed this session (U4 stream-resample).
- **WebGPU/WASM auto-detect for whisper.** Minor speed tuning; research notes WebGPU isn't reliably faster. Park it.

---

## Prior art worth tracking (GitHub)
auto-editor (silence/motion EDL), cut-the-crap (streaming long-file silence), WhisperX / faster-whisper (VAD-gated batched, server-side), CrisperWhisper (verbatim filler model, NC license), StoryToolkitAI / CutScript (Whisper + edit-by-transcript prior art), line/lighthouse (highlight/moment retrieval), PySceneDetect + MediaPipe (visual dead-time). Full digest with URLs in the session research.

---

## Suggested sequencing
S1 (re-arm detectors, ~1 line + verify) → S2 (VAD: biggest speed/reliability win + feeds S3) → S3 (dead-time, the user's actual complaint) → S4 (paraphrase repeats) → S5 (confidence). S1+S2 are the fast/reliable backbone; S3 is the "cut more of the boring stuff" payoff.
