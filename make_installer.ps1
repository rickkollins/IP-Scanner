# Builds the Windows installer:  dist\IP-Scanner-Setup-<version>.exe
# Run in PowerShell from the repository folder:  .\make_installer.ps1
# Needs Python 3.10+ from python.org and Inno Setup 6 (https://jrsoftware.org).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$version = (Select-String -Path scanner.py -Pattern '__version__ = "(.+)"').Matches[0].Groups[1].Value

if (-not (Test-Path build\venv\Scripts\pyinstaller.exe)) {
    python -m venv build\venv
    build\venv\Scripts\python -m pip install --quiet --upgrade pip pyinstaller
}
build\venv\Scripts\pyinstaller --noconfirm --log-level WARN `
    --workpath build\pyinstaller --distpath dist packaging\ip_scanner.spec

$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) { $iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" }
if (-not (Test-Path $iscc)) { throw "Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php" }
& $iscc /Qp "/DAppVersion=$version" packaging\installer.iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }
Write-Host "Built: dist\IP-Scanner-Setup-$version.exe"
