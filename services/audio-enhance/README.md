# VibeCut ClearVoice audio-enhance service

Local wrapper around [ClearerVoice-Studio](https://github.com/modelscope/ClearerVoice-Studio)
(the `clearvoice` PyPI package, Apache-2.0) that the VibeCut web app calls for
one-click audio quality improvements: reduce noise, upscale clarity, and
separate voices.

## Why a Python service

ClearVoice is a PyTorch toolkit and cannot run in the browser. The web app
proxies the selected clip's audio to this service through
`/api/audio-enhance`, which reads `CLEARVOICE_SERVICE_URL` (default
`http://127.0.0.1:8760`). This stays an optional, separately-run service: the
editor works fully without it, and the buttons show a clear "service not
running" state.

## Install and run (Windows)

```powershell
cd services/audio-enhance
./start.ps1
```

`start.ps1` creates a `.venv` (CPU-only torch to avoid the multi-GB CUDA
download), installs `requirements.txt`, and runs the service on
`http://127.0.0.1:8760`. Models download automatically from HuggingFace on
first use into `./clearvoice/checkpoints` (a few hundred MB total for the two
models the UI uses; first call is slow, later calls are warm).

The default install is CUDA torch (use `./install.ps1 -Cpu` for a CPU-only
install): an NVIDIA GPU makes enhancement roughly 50-100x faster, so an hour
of footage drops from ~4 hours of CPU compute to a few minutes on the GPU.

## API

- `GET /health` -> `{"status":"ok"}`
- `POST /enhance?task=<task>` with the RAW WAV bytes as the request body
  (`Content-Type: audio/wav`). Raw bytes are used instead of multipart because
  Starlette's multipart parser caps each part at 1 MB, which would reject
  anything longer than ~30 seconds of 16 kHz audio; the web route owns the size
  limit instead (`CLEARVOICE_MAX_AUDIO_BYTES`, default 256 MB, enough for about
  2 hours of footage at 16 kHz).
  - `denoise` -> one enhanced WAV (FRCRN_SE_16K)
  - `super_resolution` -> one upscaled WAV (MossFormer2_SR_48K)
  - `separate` -> a ZIP of per-speaker WAV stems (MossFormer2_SS_16K)
  - `balance` -> one WAV with the speakers leveled: FRCRN denoise, MossFormer2
    separation, per-stem loudness normalization to -16 dBFS, mixdown

## Long footage

Input is processed in chunks (`CLEARVOICE_CHUNK_SECONDS`, default 30) so a
multi-hour file never becomes one giant tensor. CPU inference is the real
bottleneck on a CPU-only install (roughly 4x realtime, i.e. about 4 hours per
hour of footage); with CUDA torch + an NVIDIA GPU the same job takes minutes.
Jobs run on a worker thread and expose per-chunk progress + cancel through the
job API, so the web UI can show a progress bar and a Cancel button.

## Notes

- The service is intentionally thin: no auth, no metering, loopback by default.
  The T21.3 hosted-tier metering middleware is the place to gate it in
  production, and the hosted deployment would run this service next to the web
  app with `CLEARVOICE_SERVICE_URL` pointed at it.
- Checkpoints and `.venv` are gitignored; nothing in here is a dependency of
  `bun install` or the Rust build.
