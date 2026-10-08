# PyInstaller spec for "IP Scanner.app" (a self-contained app with Python
# and Tk bundled). Built by make_dmg.sh and .github/workflows/dmg.yml:
#   pyinstaller packaging/ip_scanner.spec
# Set TARGET_ARCH=universal2 to build for both Apple silicon and Intel
# (needs a universal2 Python, such as the python.org installer).
import os
import re

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
VERSION = re.search(r'__version__ = "([^"]+)"',
                    open(os.path.join(ROOT, "scanner.py")).read()).group(1)

a = Analysis(
    [os.path.join(ROOT, "ip_scanner_gui.py")],
    pathex=[ROOT],
    datas=[(os.path.join(ROOT, "data", "oui.txt.gz"), "data"),
           (os.path.join(ROOT, "data", "icon.png"), "data")],
    hiddenimports=["scanner", "report"],
    excludes=["unittest", "pydoc", "test"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="IP Scanner",
    console=False,
    target_arch=os.environ.get("TARGET_ARCH") or None,
    codesign_identity=os.environ.get("CODESIGN_IDENTITY") or None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="IP Scanner")
app = BUNDLE(
    coll,
    name="IP Scanner.app",
    icon=os.path.join(SPECPATH, "icon.icns"),
    bundle_identifier="com.rickkollins.ipscanner",
    version=VERSION,
    info_plist={
        "CFBundleDisplayName": "IP Scanner",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
        "NSLocalNetworkUsageDescription":
            "IP Scanner probes devices on your local network to find alive "
            "hosts and open ports.",
    },
)
