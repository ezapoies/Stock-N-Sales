#define AppName "Stock N Sales"
#define AppVersion "1.0.0"
#define AppPublisher "Stock N Sales"
#define AppExeName "StockNSales.exe"

[Setup]
AppId={{A071FB27-C941-4AB5-9758-4A8D7B6A527A}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\Stock N Sales
DefaultGroupName={#AppName}
OutputDir=..\installer-output
OutputBaseFilename=Stock-N-Sales-Setup-{#AppVersion}-Windows
ArchitecturesInstallIn64BitMode=x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\{#AppExeName}

[Files]
Source: "..\dist\StockNSales\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
