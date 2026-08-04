$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# Already running? Report it and exit cleanly - starting twice must never
# error with a port conflict (the web app needs exactly one instance).
$existing = Get-NetTCPConnection -LocalPort 8760 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "ClearVoice service is already running on http://127.0.0.1:8760 (PID $($existing.OwningProcess))."
    exit 0
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    & (Join-Path $here "install.ps1")
}

$py = Join-Path $here ".venv\Scripts\python.exe"
& $py -m uvicorn main:app --host 127.0.0.1 --port 8760
