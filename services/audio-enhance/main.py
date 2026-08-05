"""ClearVoice enhancement service for VibeCut.

Thin FastAPI wrapper around the ClearerVoice-Studio `clearvoice` package
(https://github.com/modelscope/ClearerVoice-Studio). The browser cannot run
PyTorch, so the web app proxies uploaded audio here via /api/audio-enhance.

Tasks (clearvoice task, default model):
  denoise           -> speech_enhancement,     FRCRN_SE_16K
  super_resolution  -> speech_super_resolution, MossFormer2_SR_48K
  separate          -> speech_separation,      MossFormer2_SS_16K (zip of stems)

Models auto-download from HuggingFace on first use into ./clearvoice/checkpoints
relative to the working directory, so start the service from this folder
(start.ps1 does that).

Uploads are RAW WAV bytes in the request body (`?task=<task>`), not multipart:
Starlette's multipart parser caps each part at 1 MB, which would reject any
clip longer than ~30 seconds at 16 kHz. A raw body has no parser-imposed cap;
the web route owns the (configurable) size limit instead.
"""

from __future__ import annotations

import io
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response

app = FastAPI(title="VibeCut ClearVoice")

TASKS: dict[str, tuple[str, str]] = {
    "denoise": ("speech_enhancement", "FRCRN_SE_16K"),
    "super_resolution": ("speech_super_resolution", "MossFormer2_SR_48K"),
    "separate": ("speech_separation", "MossFormer2_SS_16K"),
}

MODEL_SAMPLE_RATE: dict[str, int] = {
    "FRCRN_SE_16K": 16000,
    "MossFormer2_SS_16K": 16000,
    "MossFormer2_SR_48K": 48000,
}

# Long inputs are split before inference so memory stays bounded (a 2-hour
# file never becomes one giant tensor). CPU inference is the real bottleneck
# (~4x realtime on this machine), not the chunk size; this knob only bounds
# peak memory and gives per-chunk progress.
CHUNK_SECONDS = int(os.environ.get("CLEARVOICE_CHUNK_SECONDS", "60"))
if CHUNK_SECONDS <= 0:
    CHUNK_SECONDS = 60

_instances: dict[tuple[str, str], object] = {}


def get_clearvoice(task: str, model: str) -> object:
    """Lazy per-(task, model) singleton; models download on first use."""
    key = (task, model)
    if key not in _instances:
        from clearvoice import ClearVoice

        _instances[key] = ClearVoice(task=task, model_names=[model])
    return _instances[key]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _as_mono_wavs(result: object) -> list[np.ndarray]:
    """Normalize the package's numpy output to one mono array per stem."""
    if isinstance(result, list):
        return [np.asarray(stem, dtype=np.float32).reshape(-1) for stem in result]
    arr = np.asarray(result, dtype=np.float32)
    if arr.ndim > 1:
        # The package returns (1, N) for mono or (num_spks, N); squeeze the
        # channel dim for mono, keep one row per stem otherwise.
        return [arr[i].reshape(-1) for i in range(arr.shape[0])]
    return [arr.reshape(-1)]


def _process_in_chunks(
    cv: object, in_path: Path, out_dir: Path
) -> list[np.ndarray]:
    """Run the model on the wav in chunks and return concatenated mono stems."""
    data, sr = sf.read(in_path, dtype="float32", always_2d=False)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    if data.shape[1] > 1:
        data = data.mean(axis=1, keepdims=True)  # mono mixdown
    total = data.shape[0]
    if total == 0:
        return []

    chunk_len = int(CHUNK_SECONDS * sr)
    stems: list[list[np.ndarray]] = []
    for start in range(0, total, chunk_len):
        chunk = data[start : start + chunk_len, 0]
        chunk_path = out_dir / f"chunk-{start}.wav"
        sf.write(chunk_path, chunk, sr, subtype="PCM_16")
        result = cv(input_path=str(chunk_path), online_write=False)
        chunk_stems = _as_mono_wavs(result)
        if not stems:
            stems = [[] for _ in chunk_stems]
        for idx, stem in enumerate(chunk_stems):
            if idx < len(stems):
                stems[idx].append(stem)

    return [np.concatenate(parts) for parts in stems if parts]


@app.post("/enhance")
async def enhance(
    request: Request,
    task: str = Query(...),
    model: str | None = Query(None),
) -> Response:
    if task not in TASKS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported task '{task}'. Choose from: {', '.join(TASKS)}.",
        )

    cv_task, default_model = TASKS[task]
    model = model or default_model

    workdir = Path(tempfile.mkdtemp(prefix="vibecut-cv-"))
    try:
        in_path = workdir / "input.wav"
        in_path.write_bytes(await request.body())
        if in_path.stat().st_size == 0:
            raise HTTPException(status_code=400, detail="Empty audio upload.")

        out_dir = workdir / "out"
        out_dir.mkdir()

        cv = get_clearvoice(cv_task, model)
        # Chunked inference: one request in, one WAV out, but the model only
        # ever sees CHUNK_SECONDS of audio at once, so long footage stays
        # bounded in memory and the job survives multi-hour runs.
        stems = _process_in_chunks(cv, in_path, out_dir)
        if not stems:
            raise HTTPException(
                status_code=502, detail="ClearVoice produced no output."
            )

        sample_rate = MODEL_SAMPLE_RATE.get(model, 16000)
        wavs: list[Path] = []
        for idx, stem in enumerate(stems):
            wav_path = out_dir / (f"stem{idx + 1}.wav" if len(stems) > 1 else "out.wav")
            sf.write(wav_path, stem, sample_rate, subtype="PCM_16")
            wavs.append(wav_path)

        if len(wavs) == 1:
            data = wavs[0].read_bytes()
            return Response(
                content=data,
                media_type="audio/wav",
                headers={
                    "content-length": str(len(data)),
                    "x-framecut-clearvoice-task": task,
                    "x-framecut-clearvoice-model": model,
                },
            )

        # Separation returns one stem per speaker: zip them for the caller.
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for wav in wavs:
                zf.write(wav, arcname=wav.name)
        payload = zip_buffer.getvalue()
        return Response(
            content=payload,
            media_type="application/zip",
            headers={
                "content-length": str(len(payload)),
                "x-framecut-clearvoice-task": task,
                "x-framecut-clearvoice-model": model,
                "x-framecut-clearvoice-stems": str(len(wavs)),
            },
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
