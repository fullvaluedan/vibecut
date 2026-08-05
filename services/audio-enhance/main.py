"""ClearVoice enhancement service for VibeCut.

Thin FastAPI wrapper around the ClearerVoice-Studio `clearvoice` package
(https://github.com/modelscope/ClearerVoice-Studio). The browser cannot run
PyTorch, so the web app proxies uploaded audio here via /api/audio-enhance.

Tasks (clearvoice task, default model):
  denoise           -> speech_enhancement,     FRCRN_SE_16K
  super_resolution  -> speech_super_resolution, MossFormer2_SR_48K
  separate          -> speech_separation,      MossFormer2_SS_16K (zip of stems)
  balance           -> automatic gain control: raise quiet passages (a low
                       speaker) up to the loud speaker's level, never duck,
                       soft-limit. Pure level matching, no models required

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


def _limit_peaks(
    samples: np.ndarray, ceiling: float = 0.98, ratio: float = 4.0
) -> np.ndarray:
    """Compress ONLY the region above `ceiling` at `ratio`:1 so the leveled
    body of the mix keeps its loudness while rare summed peaks are tamed.
    (Scaling the whole mix down by 1/peak undid the per-stem leveling.)"""
    magnitude = np.abs(samples)
    over = magnitude - ceiling
    limited = np.where(
        over > 0, ceiling + over / ratio, magnitude
    )
    return np.sign(samples) * limited


def _process_balance_in_chunks(
    in_path: Path, out_dir: Path
) -> list[np.ndarray]:
    """Automatic gain control: the loudness envelope raises quiet passages
    (a low speaker) UP TO the loud speaker's sustained level, never ducks the
    loud ones, and a soft limiter tames rare peaks. Pure level matching - no
    speaker separation (unreliable on imbalanced mixes) and no denoiser
    (which can gate the quiet speaker before the boost). One mono output."""
    data, sr = sf.read(in_path, dtype="float32", always_2d=False)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    if data.shape[1] > 1:
        data = data.mean(axis=1, keepdims=True)
    total = data.shape[0]
    if total == 0:
        return []

    chunk_len = int(CHUNK_SECONDS * sr)
    max_gain = 10 ** (24 / 20)  # at most +24 dB for a very quiet passage
    leveled: list[np.ndarray] = []

    for start in range(0, total, chunk_len):
        chunk = data[start : start + chunk_len, 0]
        leveled.append(_agc_balance(chunk, sr, max_gain))

    return [np.concatenate(leveled)] if leveled else []


def _agc_balance(
    samples: np.ndarray, sr: int, max_gain: float
) -> np.ndarray:
    """Upward-only AGC: measure the loud speaker's sustained level (the high
    percentile of windowed RMS), then boost quieter passages UP to it - never
    duck the loud ones. This closes the quiet-speaker gap without pumping the
    whole track. Soft-limits the result."""
    window = int(0.05 * sr)
    hop = int(0.025 * sr)
    if samples.size < window:
        rms = float(np.sqrt(np.mean(np.square(samples)))) or 1e-9
        gain = float(np.clip(rms / rms, 1.0, max_gain))
        return _limit_peaks(samples * gain)

    windows = np.lib.stride_tricks.sliding_window_view(samples, window)[::hop]
    rms = np.sqrt(np.mean(np.square(windows), axis=1)) + 1e-9
    reference = float(np.percentile(rms, 85))
    if reference <= 0:
        return samples
    gain = np.clip(reference / rms, 1.0, max_gain)

    # Fast attack, slow release so gain rises into quiet speech quickly but
    # does not pump up and down between syllables.
    smoothed = np.empty_like(gain)
    previous = gain[0]
    attack = 0.4
    release = 0.06
    for idx, current in enumerate(gain):
        if current > previous:
            previous = attack * current + (1 - attack) * previous
        else:
            previous = release * current + (1 - release) * previous
        smoothed[idx] = previous

    centers = np.arange(len(smoothed)) * hop + window // 2
    gain_samples = np.interp(
        np.arange(samples.size), centers, smoothed, left=smoothed[0], right=smoothed[-1]
    )
    return _limit_peaks(samples * gain_samples)


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
            stems = _process_balance_in_chunks(in_path, job.workdir)
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
