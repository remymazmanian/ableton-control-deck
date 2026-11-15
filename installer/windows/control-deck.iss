; Ableton Control Deck for Windows x64 and ARM64. Installs for the signed-in user (no administrator
; prompt), into %LOCALAPPDATA%\Programs\Ableton Control Deck, with Node.js for the machine's own
; architecture. Setup then runs for that user; settings and data go in %LOCALAPPDATA%\Ableton Control Deck.
; Compiled by build-installer.ps1 with /D defines: Version, Staging, NodeDir, OutDir, and optionally Icon
; and Sign (which needs the "rmsign" sign tool passed to ISCC with /S).

#define Name "Ableton Control Deck"
#define Publisher "Remy Mazmanian"

[Setup]
AppId={{923CEC0B-3844-444E-8C50-F767A3D98FC4}
AppName={#Name}
AppVersion={#Version}
AppVerName={#Name} {#Version}
AppPublisher={#Publisher}
AppPublisherURL=https://remymazmanian.com
VersionInfoVersion={#Version}
VersionInfoProductName={#Name}
VersionInfoCompany={#Publisher}
DefaultDirName={autopf}\{#Name}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible or arm64
ArchitecturesInstallIn64BitMode=x64compatible or arm64
MinVersion=10.0.17763
CloseApplications=no
OutputDir={#OutDir}
OutputBaseFilename=Ableton-Control-Deck-{#Version}-Windows-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#Name}
#ifdef Icon
SetupIconFile={#Icon}
UninstallDisplayIcon={app}\control-deck.ico
#endif
#ifdef Sign
SignTool=rmsign
SignedUninstaller=yes
#endif

[InstallDelete]
; An update replaces the program whole, so nothing from an older version is left behind.
Type: filesandordirs; Name: "{app}\dashboard"
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\max-for-live"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\remote-script"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\src"

[Files]
Source: "{#Staging}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#NodeDir}\x64\node.exe"; DestDir: "{app}\node"; Check: not IsArm64; Flags: ignoreversion
Source: "{#NodeDir}\arm64\node.exe"; DestDir: "{app}\node"; Check: IsArm64; Flags: ignoreversion
Source: "{#NodeDir}\LICENSE"; DestDir: "{app}\node"; Flags: ignoreversion
Source: "{#NodeDir}\VERSION"; DestDir: "{app}\node"; Flags: ignoreversion
#ifdef Icon
Source: "{#Icon}"; DestDir: "{app}"; DestName: "control-deck.ico"; Flags: ignoreversion
#endif

[Icons]
#ifdef Icon
Name: "{autoprograms}\{#Name}"; Filename: "http://127.0.0.1:50713/"; IconFilename: "{app}\control-deck.ico"
#else
Name: "{autoprograms}\{#Name}"; Filename: "http://127.0.0.1:50713/"
#endif

[Run]
Filename: "http://127.0.0.1:50713/connect"; Description: "Open the connection guide"; Flags: postinstall shellexec nowait skipifsilent

[UninstallDelete]
; Files the dashboard wrote while running (Next.js caches).
Type: filesandordirs; Name: "{app}"

[Code]
function PowerShellQuote(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '''', '''''', True);
  Result := '''' + Result + '''';
end;

{ Stops both services and every Node running from this install (the services and any agent's MCP
  server), so their files can be replaced or removed. }
procedure StopServices(AppDir: String);
var
  Script: String;
  Code: Integer;
begin
  if not DirExists(AppDir) then Exit;
  Script :=
    '$root = ' + PowerShellQuote(AddBackslash(AppDir)) + '; ' +
    'foreach ($n in @(''Ableton Control Deck API'', ''Ableton Control Deck Dashboard'')) { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }; ' +
    '$mine = { @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) }) }; ' +
    '& $mine | Stop-Process -Force -ErrorAction SilentlyContinue; ' +
    'for ($i = 0; $i -lt 40 -and (& $mine).Count -gt 0; $i++) { Start-Sleep -Milliseconds 250 }';
  Exec('powershell.exe', '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopServices(WizardDirValue);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LogFolder, LogFile, Command: String;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  LogFolder := ExpandConstant('{localappdata}\Ableton Control Deck\logs');
  ForceDirectories(LogFolder);
  LogFile := LogFolder + '\setup.log';
  WizardForm.StatusLabel.Caption := 'Setting up Ableton Live and the background services...';
  Command := '/d /c ""' + ExpandConstant('{app}\node\node.exe') + '" "' + ExpandConstant('{app}\scripts\setup.mjs') + '" > "' + LogFile + '" 2>&1"';
  if not Exec(ExpandConstant('{cmd}'), Command, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    SuppressibleMsgBox('Setup did not finish.' + #13#10#13#10 + LogFile, mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  KeepData: Boolean;
  Flag: String;
  Code: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  { unins000.exe /VERYSILENT keeps settings; add /REMOVEDATA=yes to remove them too. }
  if CompareText(ExpandConstant('{param:REMOVEDATA|no}'), 'yes') = 0 then KeepData := False
  else if UninstallSilent then KeepData := True
  else KeepData := TaskDialogMsgBox('Keep settings and snapshots?', '', mbConfirmation, MB_YESNO, ['Keep Settings', 'Remove Everything'], 0) = IDYES;
  StopServices(ExpandConstant('{app}'));
  if KeepData then Flag := '--keep-data' else Flag := '--remove-data';
  Exec(ExpandConstant('{app}\node\node.exe'), '"' + ExpandConstant('{app}\scripts\uninstall.mjs') + '" ' + Flag, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
  if Code <> 0 then
    SuppressibleMsgBox('Some Ableton Control Deck files could not be removed.', mbError, MB_OK, IDOK);
end;
