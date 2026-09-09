const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 1800, windowsHide: true, maxBuffer: 8192 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
async function foregroundApp(platform = process.platform) {
  if (platform === 'darwin') {
    return JSON.parse(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(a.processIdentifier),name:ObjC.unwrap(a.bundleIdentifier)||""});']));
  }
  if (platform === 'win32') {
    const script = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class OZFocus { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }\'; [uint32]$foregroundPid=0; [void][OZFocus]::GetWindowThreadProcessId([OZFocus]::GetForegroundWindow(),[ref]$foregroundPid); $p=Get-Process -Id $foregroundPid -ErrorAction Stop; @{pid=$foregroundPid;name=$p.ProcessName}|ConvertTo-Json -Compress';
    return JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  const pid = Number(await run('xdotool', ['getactivewindow', 'getwindowpid']));
  return { pid, name: (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim() };
}
function isChatApp(app) {
  return /^(com\.openai\.(chat|chatgpt|codex)|chatgpt|codex)$/i.test(app?.name || '');
}
function watchChatVisibility(onChange, { read = foregroundApp, ownPid = process.pid, intervalMs = 750 } = {}) {
  let active = false, busy = false, stopped = false;
  async function check() {
    if (busy || stopped) return;
    busy = true;
    try {
      const app = await read();
      // Clicking our controls keeps the last ChatGPT visibility state.
      const next = app.pid === ownPid ? active : isChatApp(app);
      if (!stopped) { active = next; onChange(active); }
    } catch { if (!stopped) { active = false; onChange(false); } }
    finally { busy = false; }
  }
  check();
  const timer = setInterval(check, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}
module.exports = { foregroundApp, isChatApp, watchChatVisibility };
