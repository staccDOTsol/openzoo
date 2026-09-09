/** Official current desktop installers; no third-party distribution service. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const CDN = 'https://persistent.oaistatic.com/codex-app-prod';
export function installerAsset(platform = process.platform, arch = process.arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`ChatGPT has no installer for ${platform}/${arch}; see https://chatgpt.com/download/`);
  if (platform === 'darwin') return { url: `${CDN}/${arch === 'x64' ? 'ChatGPT-latest-x64.dmg' : 'ChatGPT.dmg'}`, name: 'ChatGPT.dmg' };
  if (platform === 'win32') return { url: `${CDN}/ChatGPT-${arch}.msix`, name: 'ChatGPT.msix' };
  if (platform === 'linux') {
    const name = `chatgpt_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`;
    return { url: `${CDN}/linux/deb/latest/${name}`, name };
  }
  throw new Error(`ChatGPT desktop is not available for ${platform}; see https://chatgpt.com/download/`);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', b => { stdout = (stdout + b).slice(-1024 * 1024); });
    child.stderr?.on('data', b => { stderr = (stderr + b).slice(-8192); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

export async function downloadInstaller(url, file, fetchImpl = fetch) {
  const partial = `${file}.part`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${url}`);
    if (/text\/html/.test(response.headers.get('content-type') || '')) throw new Error(`installer URL returned HTML: ${url}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { flags: 'wx' }));
    if (!fs.statSync(partial).size) throw new Error('downloaded installer is empty');
    fs.renameSync(partial, file);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

// Query the installed package manifest instead of guessing a versioned WindowsApps path.
// The bundled Codex engine distinguishes the combined app from ChatGPT Classic.
export async function windowsChatGptApp(run = runCommand) {
  const script = `$ErrorActionPreference = 'Stop'
Get-AppxPackage | Where-Object { $_.Name -match 'OpenAI|ChatGPT|Codex' } | ForEach-Object {
  $pkg = $_
  $manifest = Get-AppxPackageManifest -Package $pkg.PackageFullName
  foreach ($entry in $manifest.Package.Applications.Application) {
    if ($entry.Executable) {
      $exe = Join-Path $pkg.InstallLocation $entry.Executable
      if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath (Join-Path (Split-Path $exe) 'resources/codex.exe'))) { Write-Output $exe }
    }
  }
}`;
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return output.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
}

export async function installChatGpt({ platform = process.platform, arch = process.arch, home = os.homedir(),
  run = runCommand, download = downloadInstaller, unpack, findWindows = windowsChatGptApp, log = console.log } = {}) {
  const asset = installerAsset(platform, arch);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openzoo-chatgpt-'));
  const file = path.join(scratch, asset.name);
  try {
    log(`downloading current ChatGPT for ${platform}/${arch} from ${asset.url}`);
    await download(asset.url, file);
    if (platform === 'linux') return unpack(file, path.join(home, '.openzoo', 'apps', 'chatgpt'));
    if (platform === 'win32') {
      // The path is passed through the environment, never interpolated into PowerShell code.
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Add-AppxPackage -Path $env:OPENZOO_CHATGPT_INSTALLER"],
      { env: { ...process.env, OPENZOO_CHATGPT_INSTALLER: file } });
      const app = await findWindows(run);
      if (!app) throw new Error('ChatGPT MSIX installed but its desktop executable was not found');
      return app;
    }
    const mount = path.join(scratch, 'mount');
    fs.mkdirSync(mount);
    let mounted = false;
    try {
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file]);
      mounted = true;
      const source = path.join(mount, 'ChatGPT.app');
      // Let macOS validate the vendor signature before copying executable code.
      await run('codesign', ['--verify', '--deep', '--strict', source]);
      if (!fs.existsSync(path.join(source, 'Contents', 'Resources', 'codex'))) throw new Error('installer contains ChatGPT Classic, not the Codex-enabled desktop app');
      const applications = path.join(home, 'Applications');
      fs.mkdirSync(applications, { recursive: true });
      const destination = path.join(applications, 'ChatGPT.app');
      if (fs.existsSync(destination)) throw new Error(`${destination} already exists but is not usable; move it aside or set OPENZOO_CHATGPT_BIN`);
      const staged = path.join(applications, `.openzoo-chatgpt-${process.pid}-${Date.now()}.app`);
      try {
        await run('ditto', [source, staged]);
        fs.renameSync(staged, destination);
      } finally { fs.rmSync(staged, { recursive: true, force: true }); }
      return path.join(destination, 'Contents', 'MacOS', 'ChatGPT');
    } finally {
      if (mounted) await run('hdiutil', ['detach', mount]);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
