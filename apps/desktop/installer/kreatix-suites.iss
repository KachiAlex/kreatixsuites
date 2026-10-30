; Kreatix Suites Windows installer (Inno Setup).
; Built from the electron-builder output in ../release/win-unpacked by
; scripts/publish.sh. The Components page lets the user choose which apps to
; install. Each ticked app gets its own Start menu entry, opens in its own
; window (--kx-app=<slug>), and claims its file types under "Open with".

#define MyAppName "Kreatix Suites"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyExe "Kreatix Suites.exe"

[Setup]
AppId={{7A3E9C10-5B2D-4E8F-A6C1-2D9F4B7E8A30}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Kreatix Technologies
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release\installer
OutputBaseFilename=Kreatix Suites-{#MyAppVersion}-x64
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#MyExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Types]
Name: "full"; Description: "All apps"
Name: "custom"; Description: "Choose the apps to install"; Flags: iscustom

[Components]
Name: "hub"; Description: "Kreatix Suites (full workspace, all apps)"; Types: full custom
Name: "writer"; Description: "Kreatix Writer — documents and reports"; Types: full custom
Name: "sheets"; Description: "Kreatix Sheets — spreadsheets and analysis"; Types: full custom
Name: "present"; Description: "Kreatix Present — slides and storytelling"; Types: full custom
Name: "board"; Description: "Kreatix Board — freehand whiteboard"; Types: full custom
Name: "pdf"; Description: "Kreatix PDF — read, edit and sign"; Types: full custom
Name: "drive"; Description: "Kreatix Drive — files and folders"; Types: full custom
Name: "mail"; Description: "Kreatavi — email and inboxes"; Types: full custom
Name: "meet"; Description: "Kreatix Meet — meetings and calls"; Types: full custom
Name: "chat"; Description: "Kreatix Chat — team messaging"; Types: full custom
Name: "calendar"; Description: "Calendar — events and schedules"; Types: full custom
Name: "tasks"; Description: "Tasks — to-dos and boards"; Types: full custom
Name: "notes"; Description: "Notes — wiki and knowledge"; Types: full custom
Name: "forms"; Description: "Forms — surveys and intake"; Types: full custom
Name: "sites"; Description: "Sites — intranet and libraries"; Types: full custom

[Files]
Source: "..\release\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Kreatix Suites"; Filename: "{app}\{#MyExe}"; Components: hub; AppUserModelID: "com.kreatixtech.suites"
Name: "{userprograms}\Kreatix Writer"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=writer"; Components: writer; AppUserModelID: "com.kreatixtech.suites.writer"
Name: "{userprograms}\Kreatix Sheets"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=sheets"; Components: sheets; AppUserModelID: "com.kreatixtech.suites.sheets"
Name: "{userprograms}\Kreatix Present"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=present"; Components: present; AppUserModelID: "com.kreatixtech.suites.present"
Name: "{userprograms}\Kreatix Board"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=board"; Components: board; AppUserModelID: "com.kreatixtech.suites.board"
Name: "{userprograms}\Kreatix PDF"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=pdf"; Components: pdf; AppUserModelID: "com.kreatixtech.suites.pdf"
Name: "{userprograms}\Kreatix Drive"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=drive"; Components: drive; AppUserModelID: "com.kreatixtech.suites.drive"
Name: "{userprograms}\Kreatavi"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=mail"; Components: mail; AppUserModelID: "com.kreatixtech.suites.mail"
Name: "{userprograms}\Kreatix Meet"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=meet"; Components: meet; AppUserModelID: "com.kreatixtech.suites.meet"
Name: "{userprograms}\Kreatix Chat"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=chat"; Components: chat; AppUserModelID: "com.kreatixtech.suites.chat"
Name: "{userprograms}\Calendar"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=calendar"; Components: calendar; AppUserModelID: "com.kreatixtech.suites.calendar"
Name: "{userprograms}\Tasks"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=tasks"; Components: tasks; AppUserModelID: "com.kreatixtech.suites.tasks"
Name: "{userprograms}\Notes"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=notes"; Components: notes; AppUserModelID: "com.kreatixtech.suites.notes"
Name: "{userprograms}\Forms"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=forms"; Components: forms; AppUserModelID: "com.kreatixtech.suites.forms"
Name: "{userprograms}\Sites"; Filename: "{app}\{#MyExe}"; Parameters: "--kx-app=sites"; Components: sites; AppUserModelID: "com.kreatixtech.suites.sites"

[Registry]
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.writer"; ValueType: string; ValueData: "Kreatix Writer"; Flags: uninsdeletekey; Components: writer
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.writer\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyExe}"" --kx-app=writer ""%1"""; Flags: uninsdeletekey; Components: writer
Root: HKCU; Subkey: "Software\Classes\.docx\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.writer"; Flags: uninsdeletevalue; Components: writer
Root: HKCU; Subkey: "Software\Classes\.docm\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.writer"; Flags: uninsdeletevalue; Components: writer
Root: HKCU; Subkey: "Software\Classes\.doc\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.writer"; Flags: uninsdeletevalue; Components: writer
Root: HKCU; Subkey: "Software\Classes\.odt\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.writer"; Flags: uninsdeletevalue; Components: writer
Root: HKCU; Subkey: "Software\Classes\.rtf\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.writer"; Flags: uninsdeletevalue; Components: writer
Root: HKCU; Subkey: "Software\Classes\.txt\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.writer"; Flags: uninsdeletevalue; Components: writer
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.sheets"; ValueType: string; ValueData: "Kreatix Sheets"; Flags: uninsdeletekey; Components: sheets
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.sheets\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyExe}"" --kx-app=sheets ""%1"""; Flags: uninsdeletekey; Components: sheets
Root: HKCU; Subkey: "Software\Classes\.xlsx\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.sheets"; Flags: uninsdeletevalue; Components: sheets
Root: HKCU; Subkey: "Software\Classes\.xls\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.sheets"; Flags: uninsdeletevalue; Components: sheets
Root: HKCU; Subkey: "Software\Classes\.csv\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.sheets"; Flags: uninsdeletevalue; Components: sheets
Root: HKCU; Subkey: "Software\Classes\.ods\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.sheets"; Flags: uninsdeletevalue; Components: sheets
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.present"; ValueType: string; ValueData: "Kreatix Present"; Flags: uninsdeletekey; Components: present
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.present\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyExe}"" --kx-app=present ""%1"""; Flags: uninsdeletekey; Components: present
Root: HKCU; Subkey: "Software\Classes\.pptx\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.present"; Flags: uninsdeletevalue; Components: present
Root: HKCU; Subkey: "Software\Classes\.odp\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.present"; Flags: uninsdeletevalue; Components: present
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.pdf"; ValueType: string; ValueData: "Kreatix PDF"; Flags: uninsdeletekey; Components: pdf
Root: HKCU; Subkey: "Software\Classes\KreatixSuites.pdf\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyExe}"" --kx-app=pdf ""%1"""; Flags: uninsdeletekey; Components: pdf
Root: HKCU; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: none; ValueName: "KreatixSuites.pdf"; Flags: uninsdeletevalue; Components: pdf

[Run]
Filename: "{app}\{#MyExe}"; Description: "Launch Kreatix Suites"; Flags: nowait postinstall skipifsilent

[Code]
const
  AppTotal = 15;

function AppKey(I: Integer): String;
begin
  case I of
    0: Result := 'suite';
    1: Result := 'writer';
    2: Result := 'sheets';
    3: Result := 'present';
    4: Result := 'board';
    5: Result := 'pdf';
    6: Result := 'drive';
    7: Result := 'mail';
    8: Result := 'meet';
    9: Result := 'chat';
    10: Result := 'calendar';
    11: Result := 'tasks';
    12: Result := 'notes';
    13: Result := 'forms';
    14: Result := 'sites';
  end;
end;

function AppName(I: Integer): String;
begin
  case I of
    0: Result := 'Kreatix Suites';
    1: Result := 'Kreatix Writer';
    2: Result := 'Kreatix Sheets';
    3: Result := 'Kreatix Present';
    4: Result := 'Kreatix Board';
    5: Result := 'Kreatix PDF';
    6: Result := 'Kreatix Drive';
    7: Result := 'Kreatavi';
    8: Result := 'Kreatix Meet';
    9: Result := 'Kreatix Chat';
    10: Result := 'Calendar';
    11: Result := 'Tasks';
    12: Result := 'Notes';
    13: Result := 'Forms';
    14: Result := 'Sites';
  end;
end;

function AppExts(Key: String): String;
begin
  Result := '';
  if Key = 'writer' then Result := 'docx docm doc odt rtf txt'
  else if Key = 'sheets' then Result := 'xlsx xls csv ods'
  else if Key = 'present' then Result := 'pptx odp'
  else if Key = 'pdf' then Result := 'pdf';
end;

function ShortcutPath(I: Integer): String;
begin
  Result := ExpandConstant('{userprograms}\') + AppName(I) + '.lnk';
end;

procedure RemoveApp(I: Integer);
var
  Key, Exts, Ext: String;
  P: Integer;
begin
  DeleteFile(ShortcutPath(I));
  Key := AppKey(I);
  if Key = 'suite' then Exit;
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\KreatixSuites.' + Key);
  Exts := AppExts(Key) + ' ';
  while Exts <> '' do
  begin
    P := Pos(' ', Exts);
    Ext := Copy(Exts, 1, P - 1);
    Exts := Copy(Exts, P + 1, Length(Exts));
    RegDeleteValue(HKCU, 'Software\Classes\.' + Ext + '\OpenWithProgids', 'KreatixSuites.' + Key);
  end;
end;

function InitializeUninstall(): Boolean;
var
  F: TForm;
  Checks: array[0..14] of TCheckBox;
  Info: TLabel;
  Ok, Cancel: TButton;
  I, Y, Installed, Selected: Integer;
  Wanted: String;
begin
  Result := True;
  Installed := 0;
  if UninstallSilent then
  begin
    Wanted := ',' + ExpandConstant('{param:KXAPPS|}') + ',';
    if Wanted = ',,' then Exit;
    Selected := 0;
    for I := 0 to AppTotal - 1 do
      if (Pos(',' + AppKey(I) + ',', Wanted) > 0) and FileExists(ShortcutPath(I)) then
        Selected := Selected + 1;
    for I := 0 to AppTotal - 1 do
      if FileExists(ShortcutPath(I)) then Installed := Installed + 1;
    if Selected >= Installed then Exit;
    for I := 0 to AppTotal - 1 do
      if Pos(',' + AppKey(I) + ',', Wanted) > 0 then RemoveApp(I);
    Result := False;
    Exit;
  end;

  F := TForm.Create(nil);
  try
    F.Caption := 'Uninstall Kreatix Suites';
    F.ClientWidth := ScaleX(440);
    F.ClientHeight := ScaleY(476);
    F.Position := poScreenCenter;
    F.BorderStyle := bsDialog;

    Info := TLabel.Create(F);
    Info.Parent := F;
    Info.Left := ScaleX(16);
    Info.Top := ScaleY(14);
    Info.Width := ScaleX(408);
    Info.WordWrap := True;
    Info.Caption := 'Choose the apps to uninstall. Apps you leave ticked are removed. Apps you leave unticked stay installed. If every installed app is ticked, Kreatix Suites is removed completely.';

    Y := ScaleY(70);
    for I := 0 to AppTotal - 1 do
    begin
      Checks[I] := TCheckBox.Create(F);
      Checks[I].Parent := F;
      Checks[I].Left := ScaleX(24);
      Checks[I].Top := Y;
      Checks[I].Width := ScaleX(390);
      Checks[I].Caption := AppName(I);
      if FileExists(ShortcutPath(I)) then
      begin
        Checks[I].Checked := True;
        Installed := Installed + 1;
      end
      else
      begin
        Checks[I].Checked := False;
        Checks[I].Enabled := False;
      end;
      Y := Y + ScaleY(24);
    end;

    Ok := TButton.Create(F);
    Ok.Parent := F;
    Ok.Caption := 'Uninstall';
    Ok.ModalResult := mrOk;
    Ok.Default := True;
    Ok.Left := ScaleX(228);
    Ok.Top := ScaleY(432);
    Ok.Width := ScaleX(92);

    Cancel := TButton.Create(F);
    Cancel.Parent := F;
    Cancel.Caption := 'Cancel';
    Cancel.ModalResult := mrCancel;
    Cancel.Cancel := True;
    Cancel.Left := ScaleX(328);
    Cancel.Top := ScaleY(432);
    Cancel.Width := ScaleX(92);

    if F.ShowModal <> mrOk then
    begin
      Result := False;
      Exit;
    end;

    Selected := 0;
    for I := 0 to AppTotal - 1 do
      if Checks[I].Checked then Selected := Selected + 1;
    if Selected = 0 then
    begin
      Result := False;
      Exit;
    end;
    if Selected >= Installed then Exit;

    for I := 0 to AppTotal - 1 do
      if Checks[I].Checked then RemoveApp(I);
    MsgBox('The selected apps were removed. Kreatix Suites stays installed for the apps you kept. Run this uninstaller again to remove them.', mbInformation, MB_OK);
    Result := False;
  finally
    F.Free;
  end;
end;
