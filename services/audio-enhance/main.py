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
"""

from __future__ import annotations

import io
import shutil
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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


@app.post("/enhance")
async def enhance(
    audio: UploadFile = File(...),
    task: str = Form(...),
    model: str | None = Form(None),
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
        in_path.write_bytes(await audio.read())
        if in_path.stat().st_size == 0:
            raise HTTPException(status_code=400, detail="Empty audio upload.")

        out_dir = workdir / "out"
        out_dir.mkdir()

        cv = get_clearvoice(cv_task, model)
        # Single-file input: online_write=False returns the processed waveform
        # as a numpy array (online_write=True only writes for directory/scp
        # inputs and drops into a model-named subdirectory).
        result = cv(input_path=str(in_path), online_write=False)
        if result is None:
            raise HTTPException(status_code=502, detail="ClearVoice returned nothing.")

        stems = _as_mono_wavs(result)
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
