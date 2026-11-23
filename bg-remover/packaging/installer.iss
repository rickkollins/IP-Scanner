; Inno Setup script for the Background Remover Windows installer.
; Build (after PyInstaller has produced bg-remover\dist\Background Remover\):
;   iscc /DAppVersion=1.0.0 bg-remover\packaging\installer.iss
; or just run bg-remover\make_installer.ps1.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{9B6E2F41-7C3A-4D85-A1E0-6F2B8C4D7E93}
AppName=Background Remover
AppVersion={#AppVersion}
AppPublisher=Rick Kollins
AppPublisherURL=https://github.com/rickkollins/IP-Scanner
DefaultDirName={autopf}\Background Remover
DefaultGroupName=Background Remover
DisableProgramGroupPage=yes
; Installs for the current user without admin rights; the setup also offers
; "install for all users".
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\dist
OutputBaseFilename=Background-Remover-Setup-{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\Background Remover.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\Background Remover\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Background Remover"; Filename: "{app}\Background Remover.exe"
Name: "{autodesktop}\Background Remover"; Filename: "{app}\Background Remover.exe"; Tasks: desktopicon

[Registry]
; "Open with > Background Remover" for image files in Explorer.
Root: HKA; Subkey: "Software\Classes\Applications\Background Remover.exe\shell\open\command"; ValueType: string; ValueData: """{app}\Background Remover.exe"" ""%1"""; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\Background Remover.exe\SupportedTypes"; ValueType: string; ValueName: ".jpg"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\Background Remover.exe\SupportedTypes"; ValueType: string; ValueName: ".jpeg"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\Background Remover.exe\SupportedTypes"; ValueType: string; ValueName: ".png"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\Background Remover.exe\SupportedTypes"; ValueType: string; ValueName: ".webp"; ValueData: ""

[Run]
Filename: "{app}\Background Remover.exe"; Description: "{cm:LaunchProgram,Background Remover}"; Flags: nowait postinstall skipifsilent
