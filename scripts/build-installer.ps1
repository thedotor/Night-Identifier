# Builds the standalone Windows installer: PyInstaller backend -> Electron app -> Inno Setup .exe.
# Run it through "Build Installer.bat" in the repo root. The backend (the slow part, PyTorch/CUDA)
# is only rebuilt when something it depends on has changed since the last build.
param(
    [switch]$ForceBackend,  # rebuild the backend even if nothing changed
    [switch]$SkipInstaller,  # stop after the packaged app (frontend\release\win-unpacked); handy for testing it
    [switch]$IncludeCanonSdk  # PRIVATE builds only: bundle the Canon EDSDK DLLs from backend\vendor\edsdk. Never share such a build (Canon forbids redistribution).
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

# Code signing is optional: set NI_SIGN_PFX to a code-signing certificate (.pfx) and NI_SIGN_PASSWORD to its
# password and the app exe, the backend exe and the installer are signed (needs signtool from the Windows SDK).
# Unsigned builds still work, but Windows SmartScreen warns about them and nothing shows they weren't tampered with.
function Find-Signtool {
    $c = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
function Sign-Files([string[]]$files) {
    if (-not $env:NI_SIGN_PFX) { return }
    $signtool = Find-Signtool
    if (-not $signtool) { throw 'NI_SIGN_PFX is set but signtool.exe was not found (install the Windows SDK).' }
    foreach ($f in $files) {
        & $signtool sign /f $env:NI_SIGN_PFX /p $env:NI_SIGN_PASSWORD /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $f
        if ($LASTEXITCODE -ne 0) { throw "Signing $f failed (exit code $LASTEXITCODE)" }
    }
}

# Canon's EDSDK is proprietary and can't be redistributed. Normal builds must never contain it, whatever is lying
# around in backend\vendor\edsdk, so this fails the build if any of its DLLs made it into the packaged app.
function Assert-NoCanonSdk([string]$dir) {
    if ($IncludeCanonSdk) { return }
    $found = Get-ChildItem $dir -Recurse -File -Include 'EDSDK.dll', 'EdsImage.dll' -ErrorAction SilentlyContinue
    if ($found) {
        throw "Canon EDSDK files are in the build (not allowed in a shareable build):`n  $($found.FullName -join "`n  ")"
    }
}
if ($IncludeCanonSdk -and $env:NI_SIGN_PFX) {
    throw 'Refusing to sign a build that includes the Canon EDSDK: signed builds are for sharing. Drop -IncludeCanonSdk.'
}
if ($IncludeCanonSdk) {
    Write-Host 'PRIVATE BUILD: includes the Canon EDSDK. Do not share or publish this installer.' -ForegroundColor Red
}

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" } }

# ---- 1. Backend -------------------------------------------------------------------------------
# The offline IP-location database for the web traffic layer is about 125 MB, so it is not in git: fetch it when it is missing.
if (-not (Test-Path (Join-Path $backend 'app\data\geoip\dbip-city-lite.mmdb'))) {
    Step 'Downloading the offline IP-location database (DB-IP Lite, once)'
    Push-Location $backend
    try {
        uv run python scripts/fetch_geoip.py
        Check 'IP database download'
    } finally { Pop-Location }
}

# Everything that ends up inside the frozen backend. If none of it changed, the old build is reused.
$inputs = @(Get-ChildItem (Join-Path $backend 'app') -Recurse -File |
        Where-Object { $_.FullName -notmatch '__pycache__' -and $_.Extension -ne '.pyc' })
# Canon's SDK is only part of the build (and so of the hash) when explicitly asked for; see the spec file.
$env:NI_INCLUDE_CANON_SDK = if ($IncludeCanonSdk) { '1' } else { '0' }
$inputs += if ($IncludeCanonSdk) { Get-ChildItem (Join-Path $backend 'vendor') -Recurse -File -ErrorAction SilentlyContinue }
           else { Get-ChildItem (Join-Path $backend 'vendor') -Recurse -File -Filter 'README.txt' -ErrorAction SilentlyContinue }
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

# PyInstaller silently leaves out a module that fails to compile, and the frozen backend then dies at start-up
# with an import error. Catch syntax errors here instead, whether or not the backend is rebuilt.
Push-Location $backend
try {
    uv run python -m compileall -q -f app run_server.py | Out-Null
    Check 'Backend syntax check'
} finally { Pop-Location }

if (-not $ForceBackend -and (Test-Path $backendExe) -and $previous -eq $hash) {
    Step 'Backend unchanged since last build - reusing it'
} else {
    Step 'Building the backend (PyInstaller; this is the slow part, several minutes)'
    Push-Location $backend
    try {
        # Ultralytics would otherwise pip-install "missing" extras (and a newer numpy) into
        # PyInstaller's temporary environment, which then shadows the project's own packages.
        $env:YOLO_AUTOINSTALL = 'False'
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

    # sign the backend before electron-builder copies it into the app folder
    if ($env:NI_SIGN_PFX) { Step 'Signing the backend'; Sign-Files @($backendExe) }

    Step 'Packaging the app (electron-builder)'
    npx electron-builder --win dir --config electron-builder.yml
    Check 'electron-builder'
    Assert-NoCanonSdk (Join-Path $frontend 'release\win-unpacked')

    if ($env:NI_SIGN_PFX) {
        Step 'Signing the app'
        Sign-Files @((Get-ChildItem (Join-Path $frontend 'release\win-unpacked') -Filter '*.exe' -File).FullName)
    }
} finally { Pop-Location }

if ($SkipInstaller) {
    Write-Host "`nPackaged app is in frontend\release\win-unpacked (installer step skipped)." -ForegroundColor Green
    return
}

# ---- 3. Installer (Inno Setup) ----------------------------------------------------------------
function Find-Iscc {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

$iscc = Find-Iscc
if (-not $iscc) {
    Step 'Installing Inno Setup (one-time, per-user, no admin needed)'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id JRSoftware.InnoSetup -e --silent --scope user --accept-package-agreements --accept-source-agreements
    }
    $iscc = Find-Iscc
    if (-not $iscc) { throw 'Inno Setup did not install. Get it from https://jrsoftware.org/isdl.php and re-run.' }
}

$release = Join-Path $frontend 'release'
Assert-NoCanonSdk (Join-Path $release 'win-unpacked')  # checked again: this is the folder Inno Setup packs
$version = (Get-Content (Join-Path $frontend 'package.json') -Raw | ConvertFrom-Json).version
# Remove the previous build's pieces so an old, longer set of .bin files can't be mistaken for the new one.
Get-ChildItem $release -Filter 'Night-Identifier-Setup*' -ErrorAction SilentlyContinue | Remove-Item -Force

Step 'Building the installer (Inno Setup; compressing several GB, takes a few minutes)'
& $iscc "/DAppVersion=$version" (Join-Path $root 'installer\night-identifier.iss')
Check 'Inno Setup'

$setup = Join-Path $release 'Night-Identifier-Setup.exe'
if (-not (Test-Path $setup)) { throw "Expected installer not found: $setup" }
Sign-Files @($setup)
$pieces = Get-ChildItem $release -Filter 'Night-Identifier-Setup*' | Sort-Object Name

# Publish these hashes next to the download so anyone can check the file wasn't altered
# (Get-FileHash <file> -Algorithm SHA256 on their side).
$sumsFile = Join-Path $release 'SHA256SUMS.txt'
$pieces | ForEach-Object { '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name } | Set-Content $sumsFile -Encoding ascii
if (-not $env:NI_SIGN_PFX) { Write-Host 'Note: the installer is NOT code-signed (set NI_SIGN_PFX / NI_SIGN_PASSWORD to sign it).' -ForegroundColor Yellow }
$total = '{0:N2} GB' -f (($pieces | Measure-Object Length -Sum).Sum / 1GB)
Write-Host "`nDone ($total in total). Keep these files together and run the .exe:" -ForegroundColor Green
$pieces | ForEach-Object { Write-Host ('  {0}  ({1:N0} MB)' -f $_.FullName, ($_.Length / 1MB)) }
