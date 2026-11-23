# PyInstaller spec for the self-contained Background Remover (Python, Tk,
# rembg and onnxruntime bundled): "Background Remover.app" on macOS,
# "Background Remover.exe" on Windows. Built by make_dmg.sh,
# make_installer.ps1 and .github/workflows/bg-remover.yml:
#   pyinstaller bg-remover/packaging/bg_remover.spec
# The AI model itself is not bundled: it downloads on first use (~/.rembg).
# Set TARGET_ARCH=universal2 for one Mac app for Apple silicon and Intel
# (needs a universal2 Python and universal2 wheels for every dependency).
import os
import re
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

APP_DIR = os.path.abspath(os.path.join(SPECPATH, ".."))
REPO = os.path.dirname(APP_DIR)  # theme.py is shared with IP Scanner
NAME = "Background Remover"
VERSION = re.search(r'__version__ = "([^"]+)"',
                    open(os.path.join(APP_DIR, "bgremove.py")).read()).group(1)

datas = [(os.path.join(APP_DIR, "assets", "icon.png"), "assets")]
datas += collect_data_files("rembg")
datas += collect_data_files("pymatting")
for dist in ("rembg", "pymatting", "onnxruntime", "pooch", "numba", "llvmlite"):
    try:
        datas += copy_metadata(dist)
    except Exception:
        pass

a = Analysis(
    [os.path.join(APP_DIR, "bg_remover_gui.py")],
    pathex=[APP_DIR, REPO],
    datas=datas,
    hiddenimports=["bgremove", "theme", "PIL._tkinter_finder", "PIL.ImageTk"]
                  + collect_submodules("rembg", filter=lambda m: ".commands" not in m)
                  + collect_submodules("pymatting"),
    excludes=["test", "matplotlib", "IPython", "pytest", "gradio",
              "fastapi", "uvicorn", "click", "aiohttp", "asyncer", "watchdog"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=NAME,
    console=False,
    icon=os.path.join(SPECPATH, "icon.ico") if sys.platform == "win32" else None,
    target_arch=os.environ.get("TARGET_ARCH") or None,
    codesign_identity=os.environ.get("CODESIGN_IDENTITY") or None,
)
coll = COLLECT(exe, a.binaries, a.datas, name=NAME)
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name=f"{NAME}.app",
        icon=os.path.join(SPECPATH, "icon.icns"),
        bundle_identifier="com.rickkollins.bgremover",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": NAME,
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            "LSMinimumSystemVersion": "14.0",  # numpy/scipy wheels need macOS 14
            "NSHighResolutionCapable": True,
            "CFBundleDocumentTypes": [{
                "CFBundleTypeName": "Image",
                "CFBundleTypeRole": "Viewer",
                "LSHandlerRank": "Alternate",
                "LSItemContentTypes": ["public.image"],
            }],
        },
    )
