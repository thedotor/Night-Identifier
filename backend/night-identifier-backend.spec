# PyInstaller spec for the packaged backend. Build it with the root "Build Installer.bat"
# (or by hand: uv run --with pyinstaller pyinstaller night-identifier-backend.spec --noconfirm).
import os

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

# Canon's EDSDK is proprietary and may not be redistributed, so a normal build never contains it, even when the DLLs are
# sitting in vendor/edsdk on the build machine (they are git-ignored). Only "Build Installer.bat -IncludeCanonSdk", for
# a private build that stays on your own PCs, sets NI_INCLUDE_CANON_SDK and lets them in.
INCLUDE_CANON_SDK = os.environ.get("NI_INCLUDE_CANON_SDK") == "1"

datas = [
    ("app/data/art", "app/data/art"),
    ("app/data/sky", "app/data/sky"),
    ("app/data/aircraft", "app/data/aircraft"),  # ICAO type table for the aircraft icons and filter
    ("app/data/geoip", "app/data/geoip"),  # offline IP -> place database for the web traffic layer (scripts/fetch_geoip.py)
    ("vendor", "vendor") if INCLUDE_CANON_SDK else ("vendor/edsdk/README.txt", "vendor/edsdk"),
    ("yolov8n.pt", "."),
]
datas += collect_data_files("ultralytics")
datas += collect_data_files("certifi")  # CA roots the backend trusts (app/services/tls.py)

hiddenimports = []
# ecCodes decodes the GFS wind files (app/services/flow.py). It carries its own DLLs and loads them by path, which the import
# analysis does not see, so take the whole package.
binaries = []
for pkg in ("eccodes", "gribapi"):
    _d, _b, _h = collect_all(pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h
# `app` (live camera drivers are loaded with importlib), uvicorn's pluggable loops/protocols,
# and packages that import their own submodules dynamically.
for pkg in ("app", "uvicorn", "websockets", "ultralytics", "watchdog", "sqlalchemy.dialects.sqlite"):
    hiddenimports += collect_submodules(pkg)

a = Analysis(
    ["run_server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "IPython", "jupyter", "notebook"],
)
# PyInstaller also copies every torch/lib DLL (multi-GB of CUDA) to the top level, where torch never
# looks: it loads them from torch/lib. Dropping the duplicates roughly halves the installer.
def _norm(name):
    return name.replace("\\", "/").lower()


_torch_lib = {_norm(e[0]).rsplit("/", 1)[-1] for toc in (a.binaries, a.datas) for e in toc if _norm(e[0]).startswith("torch/lib/")}
_is_duplicate = lambda e: "/" not in _norm(e[0]) and _norm(e[0]) in _torch_lib
a.binaries = [e for e in a.binaries if not _is_duplicate(e)]
a.datas = [e for e in a.datas if not _is_duplicate(e)]

# Belt and braces: whatever pulled a Canon SDK file in (a dependency scan, a stray copy), it does not ship.
_is_canon_sdk = lambda e: _norm(e[0]).rsplit("/", 1)[-1] in {"edsdk.dll", "edsimage.dll"} or "/edsdk/" in _norm(e[0]) and not _norm(e[0]).endswith("readme.txt")
if not INCLUDE_CANON_SDK:
    a.binaries = [e for e in a.binaries if not _is_canon_sdk(e)]
    a.datas = [e for e in a.datas if not _is_canon_sdk(e)]

pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="night-identifier-backend",
    console=True,  # Electron spawns it hidden and reads its output
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="night-identifier-backend", upx=False)
