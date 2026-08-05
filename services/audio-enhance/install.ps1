param([switch]$Cpu)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    python -m venv .venv
}

$py = Join-Path $here ".venv\Scripts\python.exe"

& $py -m pip install --upgrade pip
# GPU (CUDA) torch by default - the RTX-class GPU makes enhancement ~50-100x
# faster than CPU. Use `./install.ps1 -Cpu` for a small CPU-only install.
if ($Cpu) {
    & $py -m pip install "torch" "torchaudio" "torchvision" --index-url https://download.pytorch.org/whl/cpu
} else {
    & $py -m pip install "torch" "torchaudio" "torchvision" --index-url https://download.pytorch.org/whl/cu128
}
& $py -m pip install -r requirements.txt
# clearvoice pins numpy<2.0, but the CUDA torch line can pull numpy 2; pin it
# back explicitly so the package imports cleanly.
& $py -m pip install "numpy==1.26.4"

Write-Host "ClearVoice install complete."
