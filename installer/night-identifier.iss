; Inno Setup script for the Night Identifier installer. Compiled by scripts/build-installer.ps1
; (which passes /DAppVersion=... and /DSourceDir=...). Inno is used instead of NSIS because the
; bundled PyTorch/CUDA backend is several GB, past NSIS's 2 GB limit; Inno splits the installer into
; Night-Identifier-Setup.exe plus Night-Identifier-Setup-1.bin, -2.bin, ... which must stay together.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\frontend\release\win-unpacked"
#endif

[Setup]
; Same AppId on every build, so running a newer setup upgrades the existing install in place.
AppId={{5B1E6C0A-3F0B-4D7E-9C55-6E0F2A8D7B41}
AppName=Night Identifier
AppVersion={#AppVersion}
AppPublisher=Night Identifier
; Per-user install under %LOCALAPPDATA%\Programs: no admin prompt.
PrivilegesRequired=lowest
DefaultDirName={autopf}\Night Identifier
DefaultGroupName=Night Identifier
DisableProgramGroupPage=yes
UninstallDisplayName=Night Identifier
UninstallDisplayIcon={app}\Night Identifier.exe
SetupIconFile=..\frontend\build\icon.ico
OutputDir=..\frontend\release
OutputBaseFilename=Night-Identifier-Setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=8
DiskSpanning=yes
DiskSliceSize=2000000000
SlicesPerDisk=1
WizardStyle=modern
; Images, models and the database live in Documents\Night Identifier and are never touched here.

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[InstallDelete]
; Start each upgrade from a clean backend so files dropped from a newer build don't linger.
Type: filesandordirs; Name: "{app}\resources\backend"

[Icons]
Name: "{autoprograms}\Night Identifier"; Filename: "{app}\Night Identifier.exe"
Name: "{autodesktop}\Night Identifier"; Filename: "{app}\Night Identifier.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\Night Identifier.exe"; Description: "Launch Night Identifier"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM ""Night Identifier.exe"""; Flags: runhidden; RunOnceId: "KillApp"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM night-identifier-backend.exe"; Flags: runhidden; RunOnceId: "KillBackend"

[Code]
// An upgrade can't overwrite files of a running app, so stop it (and its backend) first.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM "Night Identifier.exe"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM night-identifier-backend.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(1000);
  Result := '';
end;
