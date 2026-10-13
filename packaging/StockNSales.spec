import os
import sys

from PyInstaller.utils.hooks import collect_all


project_root = os.path.abspath(os.path.join(SPECPATH, ".."))
datas = [
    (os.path.join(project_root, "index.html"), "."),
    (os.path.join(project_root, "manifest.json"), "."),
    (os.path.join(project_root, "service-worker.js"), "."),
    (os.path.join(project_root, "Logo.png"), "."),
    (os.path.join(project_root, "css"), "css"),
    (os.path.join(project_root, "js"), "js"),
    (os.path.join(project_root, "icons"), "icons"),
]
binaries = []
hiddenimports = []

for package in (
    "flask",
    "flask_cors",
    "dotenv",
    "joblib",
    "numpy",
    "pandas",
    "pymongo",
    "sklearn",
    "webview",
):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

a = Analysis(
    [os.path.join(project_root, "desktop.py")],
    pathex=[project_root],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "unittest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

if sys.platform == "darwin":
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="StockNSales",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=True,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
    app = BUNDLE(
        exe,
        name="Stock N Sales.app",
        icon=None,
        bundle_identifier="com.stocknsales.desktop",
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="StockNSales",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        console=False,
        disable_windowed_traceback=False,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=[],
        name="StockNSales",
    )
