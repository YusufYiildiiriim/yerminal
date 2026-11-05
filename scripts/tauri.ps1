[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TauriArgs)

$ErrorActionPreference = 'Stop'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Test-Path (Join-Path $cargoBin 'cargo.exe'))) {
    throw "Cargo was not found at $cargoBin. Install Rustup first."
}
if (($env:Path -split ';') -notcontains $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
}

$vsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsInstall = if (Test-Path $vsWhere) {
    (& $vsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1).Trim()
} else {
    Join-Path $env:ProgramFiles 'Microsoft Visual Studio\18\Community'
}
$devShell = Join-Path $vsInstall 'Common7\Tools\Launch-VsDevShell.ps1'
if (-not (Test-Path $devShell)) {
    throw "Visual Studio Developer PowerShell was not found under $vsInstall. Install the MSVC C++ build tools."
}
. $devShell -VsInstallationPath $vsInstall -NoLogo

$tauriCli = Join-Path (Split-Path $PSScriptRoot -Parent) 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path $tauriCli)) {
    throw 'Tauri CLI is missing. Run npm install in the project directory.'
}
& $tauriCli @TauriArgs
exit $LASTEXITCODE