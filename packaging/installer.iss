; Inno Setup script for the IP Scanner Windows installer.
; Build (after PyInstaller has produced dist\IP Scanner\):
;   iscc /DAppVersion=2.2.0 packaging\installer.iss
; or just run make_installer.ps1.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{3F1C2B7A-8D4E-4A6B-9C2D-5E7F8A9B0C14}
AppName=IP Scanner
AppVersion={#AppVersion}
AppPublisher=Rick Kollins
AppPublisherURL=https://github.com/rickkollins/IP-Scanner
DefaultDirName={autopf}\IP Scanner
DefaultGroupName=IP Scanner
DisableProgramGroupPage=yes
; Installs for the current user without admin rights; the setup also offers
; "install for all users".
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\dist
OutputBaseFilename=IP-Scanner-Setup-{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\IP Scanner.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\IP Scanner\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\IP Scanner"; Filename: "{app}\IP Scanner.exe"
Name: "{autodesktop}\IP Scanner"; Filename: "{app}\IP Scanner.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\IP Scanner.exe"; Description: "{cm:LaunchProgram,IP Scanner}"; Flags: nowait postinstall skipifsilent
