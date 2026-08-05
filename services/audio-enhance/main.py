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
(start.ps1 does that). CUDA is used automatically when available.

Uploads are RAW WAV bytes in the request body (`?task=<task>`), not multipart:
Starlette's multipart parser caps each part at 1 MB, which would reject any
clip longer than ~30 seconds at 16 kHz. A raw body has no parser-imposed cap;
the web route owns the (configurable) size limit instead.

Long jobs run on a worker THREAD (never the event loop) and are exposed as a
job API so the UI can show per-chunk progress and cancel:

  POST  /enhance?task=<task>          -> {"jobId": "..."} (raw WAV body)
  GET   /enhance/{jobId}              -> progress/status
  POST  /enhance/{jobId}/cancel       -> stop between chunks
  GET   /enhance/{jobId}/result       -> the enhanced WAV (or ZIP for separate)
"""

from __future__ import annotations

import io
import os
import shutil
import tempfile
import threading
import uuid
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
    "balance": ("speech_enhancement", "FRCRN_SE_16K"),
}

MODEL_SAMPLE_RATE: dict[str, int] = {
    "FRCRN_SE_16K": 16000,
    "MossFormer2_SS_16K": 16000,
    "MossFormer2_SR_48K": 48000,
}

# Long inputs are split before inference so memory stays bounded and progress
# can be reported per chunk. 30s keeps cancel latency and progress ticks short
# (on GPU a chunk is sub-second; on CPU it is a couple of minutes).
CHUNK_SECONDS = int(os.environ.get("CLEARVOICE_CHUNK_SECONDS", "30"))
if CHUNK_SECONDS <= 0:
    CHUNK_SECONDS = 30

_instances: dict[tuple[str, str], object] = {}
_instances_lock = threading.Lock()


def get_clearvoice(task: str, model: str) -> object:
    """Lazy per-(task, model) singleton; models download on first use."""
    key = (task, model)
    with _instances_lock:
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


def _gated_rms(samples: np.ndarray) -> float:
    """RMS ignoring near-silence, so pauses don't drag the level down."""
    window = int(16000 * 0.05)  # 50ms
    gate = 10 ** (-45 / 20)
    if samples.size < window:
        return float(np.sqrt(np.mean(np.square(samples))) if samples.size else 0.0)
    windows = samples[: (samples.size // window) * window].reshape(-1, window)
    rms = np.sqrt(np.mean(np.square(windows), axis=1))
    audible = rms[rms >= gate]
    return float(np.sqrt(np.mean(np.square(audible)))) if audible.size else 0.0


def _normalize_stem(
    samples: np.ndarray, target: float, max_gain: float
) -> np.ndarray:
    """Scale one stem's speech to `target` RMS, capped to `max_gain` so a very
    quiet stem never becomes a noise bomb."""
    current = _gated_rms(samples)
    if current <= 0:
        return samples
    gain = min(target / current, max_gain)
    return samples * gain


def _process_balance_in_chunks(
    cv_denoise: object,
    cv_separate: object,
    in_path: Path,
    out_dir: Path,
) -> list[np.ndarray]:
    """Denoise, separate speakers, level each stem to a common dialog RMS,
    and mix back down. One mono output."""
    data, sr = sf.read(in_path, dtype="float32", always_2d=False)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    if data.shape[1] > 1:
        data = data.mean(axis=1, keepdims=True)
    total = data.shape[0]
    if total == 0:
        return []

    chunk_len = int(CHUNK_SECONDS * sr)
    target = 10 ** (-16 / 20)  # -16 dBFS, the same dialog target the editor uses
    max_gain = 10 ** (12 / 20)  # at most +12 dB per stem
    mixed: list[np.ndarray] = []

    for start in range(0, total, chunk_len):
        chunk = data[start : start + chunk_len, 0]
        chunk_path = out_dir / f"chunk-{start}.wav"
        sf.write(chunk_path, chunk, sr, subtype="PCM_16")

        denoised = _as_mono_wavs(
            cv_denoise(input_path=str(chunk_path), online_write=False)
        )[0]
        denoised_path = out_dir / f"chunk-{start}-denoised.wav"
        sf.write(denoised_path, denoised, sr, subtype="PCM_16")

        stems = _as_mono_wavs(
            cv_separate(input_path=str(denoised_path), online_write=False)
        )
        if not stems:
            continue
        leveled = [
            _normalize_stem(np.asarray(stem, dtype=np.float32), target, max_gain)
            for stem in stems
        ]
        mix = np.sum(leveled, axis=0)
        peak = float(np.max(np.abs(mix))) if mix.size else 0.0
        if peak > 1.0:
            mix = mix * (1.0 / peak)
        mixed.append(mix.astype(np.float32))

    return [np.concatenate(mixed)] if mixed else []


class Job:
    def __init__(self, job_id: str, task: str, model: str, workdir: Path):
        self.id = job_id
        self.task = task
        self.model = model
        self.workdir = workdir
        self.status = "pending"  # pending | running | done | failed | cancelled
        self.done_chunks = 0
        self.total_chunks = 0
        self.error: str | None = None
        self.cancel_requested = threading.Event()
        self.result_paths: list[Path] = []

    def summary(self) -> dict[str, object]:
        return {
            "jobId": self.id,
            "status": self.status,
            "doneChunks": self.done_chunks,
            "totalChunks": self.total_chunks,
            "error": self.error,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


def _run_job(job: Job, in_path: Path) -> None:
    try:
        job.status = "running"
        cv_task, _ = TASKS[job.task]

        data, sr = sf.read(in_path, dtype="float32", always_2d=False)
        if data.ndim == 1:
            data = data.reshape(-1, 1)
        if data.shape[1] > 1:
            data = data.mean(axis=1, keepdims=True)  # mono mixdown
        total = data.shape[0]
        if total == 0:
            raise ValueError("The uploaded audio has no samples.")

        chunk_len = int(CHUNK_SECONDS * sr)
        job.total_chunks = max(1, (total + chunk_len - 1) // chunk_len)

        if job.task == "balance":
            cv_denoise = get_clearvoice("speech_enhancement", "FRCRN_SE_16K")
            cv_separate = get_clearvoice(
                "speech_separation", "MossFormer2_SS_16K"
            )
            stems = _process_balance_in_chunks(
                cv_denoise, cv_separate, in_path, job.workdir
            )
            job.done_chunks = job.total_chunks
            if job.cancel_requested.is_set():
                job.status = "cancelled"
                return
            if not stems:
                raise ValueError("ClearVoice produced no output.")
            wav_path = job.workdir / "out.wav"
            sf.write(wav_path, stems[0], 16000, subtype="PCM_16")
            job.result_paths.append(wav_path)
            job.status = "done"
            return

        cv = get_clearvoice(cv_task, job.model)
        stems: list[list[np.ndarray]] = []

        for start in range(0, total, chunk_len):
            if job.cancel_requested.is_set():
                job.status = "cancelled"
                return
            chunk = data[start : start + chunk_len, 0]
            chunk_path = job.workdir / f"chunk-{start}.wav"
            sf.write(chunk_path, chunk, sr, subtype="PCM_16")
            result = cv(input_path=str(chunk_path), online_write=False)
            chunk_stems = _as_mono_wavs(result)
            if not stems:
                stems = [[] for _ in chunk_stems]
            for idx, stem in enumerate(chunk_stems):
                if idx < len(stems):
                    stems[idx].append(stem)
            job.done_chunks += 1

        if job.cancel_requested.is_set():
            job.status = "cancelled"
            return
        if not stems:
            raise ValueError("ClearVoice produced no output.")

        sample_rate = MODEL_SAMPLE_RATE.get(job.model, 16000)
        for idx, stem in enumerate(stems):
            name = f"stem{idx + 1}.wav" if len(stems) > 1 else "out.wav"
            wav_path = job.workdir / name
            sf.write(wav_path, np.concatenate(stem), sample_rate, subtype="PCM_16")
            job.result_paths.append(wav_path)
        job.status = "done"
    except Exception as exc:  # pragma: no cover - surface any worker failure
        job.status = "failed"
        job.error = str(exc)


def _has_active_job() -> bool:
    with JOBS_LOCK:
        return any(job.status in ("pending", "running") for job in JOBS.values())


@app.post("/enhance")
async def enhance(
    request: Request,
    task: str = Query(...),
    model: str | None = Query(None),
) -> dict[str, str]:
    if task not in TASKS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported task '{task}'. Choose from: {', '.join(TASKS)}.",
        )
    if _has_active_job():
        raise HTTPException(
            status_code=409,
            detail="Another enhancement is already running. Cancel it or wait for it to finish.",
        )

    job_id = uuid.uuid4().hex[:12]
    workdir = Path(tempfile.mkdtemp(prefix=f"vibecut-cv-{job_id}-"))
    in_path = workdir / "input.wav"
    in_path.write_bytes(await request.body())
    if in_path.stat().st_size == 0:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Empty audio upload.")

    _, default_model = TASKS[task]
    job = Job(job_id, task, model or default_model, workdir)
    with JOBS_LOCK:
        JOBS[job_id] = job

    thread = threading.Thread(target=_run_job, args=(job, in_path), daemon=True)
    job.thread = thread
    thread.start()
    return {"jobId": job_id}


def _get_job(job_id: str) -> Job:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job.")
    return job


@app.get("/enhance/{job_id}")
def job_status(job_id: str) -> dict[str, object]:
    return _get_job(job_id).summary()


@app.post("/enhance/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, str]:
    job = _get_job(job_id)
    if job.status in ("done", "failed", "cancelled"):
        return {"jobId": job_id, "status": job.status}
    job.cancel_requested.set()
    return {"jobId": job_id, "status": "cancelling"}


@app.get("/enhance/{job_id}/result")
def job_result(job_id: str) -> Response:
    job = _get_job(job_id)
    if job.status != "done":
        raise HTTPException(status_code=409, detail=f"Job is {job.status}, not done.")
    if len(job.result_paths) == 1:
        data = job.result_paths[0].read_bytes()
        return Response(
            content=data,
            media_type="audio/wav",
            headers={
                "content-length": str(len(data)),
                "x-framecut-clearvoice-task": job.task,
                "x-framecut-clearvoice-model": job.model,
            },
        )

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for wav in job.result_paths:
            zf.write(wav, arcname=wav.name)
    payload = zip_buffer.getvalue()
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            "content-length": str(len(payload)),
            "x-framecut-clearvoice-task": job.task,
            "x-framecut-clearvoice-model": job.model,
        },
    )
