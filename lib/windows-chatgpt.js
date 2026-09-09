import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CommandLineToArgvW quoting, without invoking cmd.exe or interpreting shell syntax.
export function windowsArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export function packagedLaunchScript({ app, args, env, statusFile }) {
  const data = Buffer.from(JSON.stringify({ app, args, statusFile,
    env: { CODEX_HOME: env.CODEX_HOME, CODEX_ELECTRON_USER_DATA_PATH: env.CODEX_ELECTRON_USER_DATA_PATH,
      OPENZOO_API_KEY: env.OPENZOO_API_KEY } }), 'utf8').toString('base64');
  // This initializer runs INSIDE the package identity. Explicitly set the
  // isolated profile there instead of relying on activation-broker inheritance.
  const child = `$ErrorActionPreference = 'Stop'
$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
try {
  foreach ($entry in $d.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process') }
  $p = Start-Process -FilePath $d.app -ArgumentList $d.args -WorkingDirectory (Split-Path -LiteralPath $d.app) -PassThru
  Start-Sleep -Milliseconds 1500
  if ($p.HasExited -and $p.ExitCode -ne 0) { throw "ChatGPT exited during launch ($($p.ExitCode))" }
  @{ok=$true;pid=$p.Id} | ConvertTo-Json -Compress | Set-Content -LiteralPath $d.statusFile -Encoding UTF8
} catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress | Set-Content -LiteralPath $d.statusFile -Encoding UTF8; exit 1 }
`;
  const encoded = Buffer.from(child, 'utf16le').toString('base64');
  return `$ErrorActionPreference = 'Stop'
$target = $env:OPENZOO_PACKAGED_APP
$match = $null
foreach ($pkg in (Get-AppxPackage | Where-Object { $_.Name -match 'OpenAI|ChatGPT|Codex' })) {
  $manifest = Get-AppxPackageManifest -Package $pkg.PackageFullName
  foreach ($entry in $manifest.Package.Applications.Application) {
    if ($entry.Executable -and ((Join-Path $pkg.InstallLocation $entry.Executable) -eq $target)) {
      $match = @{family=$pkg.PackageFamilyName;id=[string]$entry.Id}
      break
    }
  }
  if ($match) { break }
}
if (!$match) { throw 'The ChatGPT package registration could not be found. Repair ChatGPT in Windows Settings and try again.' }
Invoke-CommandInDesktopPackage -PackageFamilyName $match.family -AppId $match.id -Command "$PSHOME\\powershell.exe" -Args '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}' -PreventBreakaway | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds(25)
while (!(Test-Path -LiteralPath $env:OPENZOO_LAUNCH_STATUS)) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'ChatGPT did not confirm startup. Close ChatGPT and try Launch again.' }
  Start-Sleep -Milliseconds 200
}
$result = Get-Content -LiteralPath $env:OPENZOO_LAUNCH_STATUS -Raw | ConvertFrom-Json
if (!$result.ok) { throw $result.error }
Write-Output $result.pid
`;
}

export async function launchWindowsPackage(app, args, { env, run }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openzoo-launch-'));
  const statusFile = path.join(scratch, 'status.json');
  try {
    const commandLine = [`--user-data-dir=${env.CODEX_ELECTRON_USER_DATA_PATH}`, ...args].map(windowsArgument).join(' ');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      packagedLaunchScript({ app, args: commandLine, env, statusFile })],
    { windowsHide: true, env: { ...env, OPENZOO_PACKAGED_APP: app, OPENZOO_LAUNCH_STATUS: statusFile } });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
