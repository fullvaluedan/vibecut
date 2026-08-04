$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    & (Join-Path $here "install.ps1")
}

$py = Join-Path $here ".venv\Scripts\python.exe"
& $py -m uvicorn main:app --host 127.0.0.1 --port 8760
