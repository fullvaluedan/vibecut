$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    python -m venv .venv
}

$py = Join-Path $here ".venv\Scripts\python.exe"

& $py -m pip install --upgrade pip
# CPU-only torch first (the default PyPI wheel pulls multi-GB CUDA runtimes
# that this service does not use). clearvoice pins numpy<2.0, so install the
# explicit torch stack before the package to keep pip from resolving a
# conflicting numpy with the CUDA build.
& $py -m pip install "torch" "torchaudio" "torchvision" --index-url https://download.pytorch.org/whl/cpu
& $py -m pip install -r requirements.txt

Write-Host "ClearVoice install complete."
