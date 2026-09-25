# Builds the standalone Windows installer: PyInstaller backend -> Electron app -> NSIS setup .exe.
# Run it through "Build Installer.bat" in the repo root. The backend (the slow part, PyTorch/CUDA)
# is only rebuilt when something it depends on has changed since the last build.
param(
    [switch]$ForceBackend  # rebuild the backend even if nothing changed
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$backendOut = Join-Path $backend 'dist\night-identifier-backend'
$backendExe = Join-Path $backendOut 'night-identifier-backend.exe'
$stampFile = Join-Path $backend 'build\inputs.hash'

# Clearing this is cheap insurance: if it's set, Electron runs as plain Node instead of a GUI.
$env:ELECTRON_RUN_AS_NODE = $null

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" } }

# ---- 1. Backend -------------------------------------------------------------------------------
# Everything that ends up inside the frozen backend. If none of it changed, the old build is reused.
$inputs = @(Get-ChildItem (Join-Path $backend 'app') -Recurse -File |
        Where-Object { $_.FullName -notmatch '__pycache__' -and $_.Extension -ne '.pyc' })
$inputs += Get-ChildItem (Join-Path $backend 'vendor') -Recurse -File -ErrorAction SilentlyContinue
foreach ($f in 'pyproject.toml', 'uv.lock', 'night-identifier-backend.spec', 'run_server.py', 'yolov8n.pt') {
    $inputs += Get-Item (Join-Path $backend $f)
}
$lines = $inputs | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($backend.Length)
    "$rel $((Get-FileHash $_.FullName -Algorithm SHA1).Hash)"
}
$bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
$hash = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash($bytes))
$previous = if (Test-Path $stampFile) { (Get-Content $stampFile -Raw).Trim() } else { '' }

if (-not $ForceBackend -and (Test-Path $backendExe) -and $previous -eq $hash) {
    Step 'Backend unchanged since last build - reusing it'
} else {
    Step 'Building the backend (PyInstaller; this is the slow part, several minutes)'
    Push-Location $backend
    try {
        # --with keeps PyInstaller out of the project's own virtualenv and lockfile.
        uv run --with pyinstaller pyinstaller night-identifier-backend.spec --noconfirm
        Check 'PyInstaller'
    } finally { Pop-Location }
    New-Item -ItemType Directory -Force (Split-Path $stampFile) | Out-Null
    Set-Content $stampFile $hash
}

# ---- 2. Frontend + installer ------------------------------------------------------------------
Push-Location $frontend
try {
    if (-not (Test-Path 'node_modules')) {
        Step 'Installing frontend dependencies'
        npm install
        Check 'npm install'
    }
    Step 'Building the app'
    npx electron-vite build
    Check 'electron-vite build'

    Step 'Packaging the installer (electron-builder)'
    npx electron-builder --win --config electron-builder.yml
    Check 'electron-builder'
} finally { Pop-Location }

$setup = Join-Path $frontend 'release\Night-Identifier-Setup.exe'
if (-not (Test-Path $setup)) { throw "Expected installer not found: $setup" }
$size = '{0:N2} GB' -f ((Get-Item $setup).Length / 1GB)
Write-Host "`nDone. Installer ($size):`n  $setup" -ForegroundColor Green
