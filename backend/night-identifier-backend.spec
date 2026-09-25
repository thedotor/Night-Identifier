# PyInstaller spec for the packaged backend. Build it with the root "Build Installer.bat"
# (or by hand: uv run --with pyinstaller pyinstaller night-identifier-backend.spec --noconfirm).
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = [
    ("app/data/art", "app/data/art"),
    ("app/data/sky", "app/data/sky"),
    ("vendor", "vendor"),  # Canon EDSDK DLLs, if the user placed them here
    ("yolov8n.pt", "."),
]
datas += collect_data_files("ultralytics")

hiddenimports = []
# `app` (live camera drivers are loaded with importlib), uvicorn's pluggable loops/protocols,
# and packages that import their own submodules dynamically.
for pkg in ("app", "uvicorn", "ultralytics", "watchdog", "sqlalchemy.dialects.sqlite"):
    hiddenimports += collect_submodules(pkg)

a = Analysis(
    ["run_server.py"],
    pathex=["."],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "IPython", "jupyter", "notebook"],
)
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
