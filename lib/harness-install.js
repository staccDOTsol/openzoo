/**
 * First-run Claude Auto harness for grokui desktop.
 *
 * The app RUNS the platform-correct install (official Claude, Node 24,
 * global openzoo, then `openzoo claude --setup`). Do not dump a curl/nvm
 * recipe into chat or release notes — this module is the install path.
 *
 * Mac/Linux: claude.ai/install.sh + nvm-sh + Node 24 + npm i -g openzoo
 *            + PATH ~/.local/bin + openzoo claude --setup
 * Windows:   official install.ps1 + nvm-windows (nvm-setup.exe) + Node 24
 *            + npm i -g openzoo + openzoo claude --setup
 *            NEVER unix nvm curl. NEVER source ~/.zshrc.
 *
 * Idempotent. Does not block grokui listen / window paint — callers must
 * `void ensureHarness()` after the UI is up (same rule as :8402).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeZooEnv, resolveClaudeCli, claudeCodeBinDirs } from './launch.js';

export const NVM_SH_VERSION = 'v0.40.7';
export const NVM_SH_URL = `https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_SH_VERSION}/install.sh`;
export const CLAUDE_UNIX_INSTALL = 'https://claude.ai/install.sh';
export const CLAUDE_WIN_PS1 = 'https://claude.ai/install.ps1';
export const NVM_WINDOWS_SETUP = 'https://github.com/coreybutler/nvm-windows/releases/latest/download/nvm-setup.exe';
export const UNIX_PATH_SNIPPET = 'export PATH="$HOME/.local/bin:$PATH"';

export const HARNESS_STATUS = Object.freeze({
  claude: 'Installing Claude…',
  node: 'Installing Node 24…',
  openzoo: 'Installing openzoo…',
  configure: 'Pointing Claude at OpenZoo…',
  ready: 'Claude Auto is ready',
  skipped: 'Claude Auto already installed',
});

const DEFAULT_STATE = () => ({
  ready: false,
  installing: false,
  skipped: false,
  step: '',
  message: '',
  error: '',
});

let state = DEFAULT_STATE();
let inflight = null;
let runnerOverride = null;

export function getHarnessState() {
  return { ...state };
}

export function setHarnessStateForTest(next) {
  state = { ...DEFAULT_STATE(), ...(next || {}) };
}

export function setHarnessInstallRunnerForTest(fn) {
  runnerOverride = typeof fn === 'function' ? fn : null;
}

export function shouldSkipHarnessAutostart(env = process.env) {
  return env.OZ_SKIP_HARNESS === '1' || env.OZ_AGENT_PORTS === '0';
}

export function unixPathSnippet() {
  return UNIX_PATH_SNIPPET;
}

function whichOnPath(name, env, extras = [], exists = existsSync) {
  const exe = process.platform === 'win32' && !/\.\w+$/.test(name) ? `${name}.cmd` : name;
  const also = process.platform === 'win32' && exe.endsWith('.cmd') ? [name + '.exe', name] : [name];
  const dirs = [...extras, ...String(env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const n of [exe, ...also]) {
      const f = path.join(dir, n);
      if (exists(f)) return f;
    }
  }
  return null;
}

export function nvmShPath(home = os.homedir(), env = process.env) {
  return path.join(env.NVM_DIR || path.join(home, '.nvm'), 'nvm.sh');
}

export function nvmWindowsHome(home = os.homedir(), env = process.env) {
  return env.NVM_HOME
    || path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nvm');
}

function nodeMajorFromVersion(text) {
  const m = String(text || '').match(/v?(\d+)/);
  return m ? Number(m[1]) : 0;
}

function listNode24Bins({ home, env, platform, exists, readDir }) {
  const bins = [];
  if (platform === 'win32') {
    const nvmHome = nvmWindowsHome(home, env);
    const symlink = env.NVM_SYMLINK || path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs');
    bins.push(path.join(symlink, 'node.exe'));
    try {
      for (const d of readDir(nvmHome)) {
        if (/^v?24\b/.test(d)) bins.push(path.join(nvmHome, d, 'node.exe'));
      }
    } catch { /* no nvm versions */ }
    return bins.filter((p) => exists(p));
  }
  const nvmDir = env.NVM_DIR || path.join(home, '.nvm');
  try {
    const versions = path.join(nvmDir, 'versions', 'node');
    for (const d of readDir(versions)) {
      if (/^v24\b/.test(d)) bins.push(path.join(versions, d, 'bin', 'node'));
    }
  } catch { /* no nvm */ }
  return bins.filter((p) => exists(p));
}

export function detectHarness({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  exists = existsSync,
  execFileSync,
  resolveClaude = resolveClaudeCli,
} = {}) {
  const extras = claudeCodeBinDirs(home);
  const pathEnv = {
    ...env,
    PATH: [...new Set([...extras, ...String(env.PATH || '').split(path.delimiter)])].join(path.delimiter),
  };
  const claudePath = resolveClaude(pathEnv);
  const nvm = platform === 'win32'
    ? Boolean(whichOnPath('nvm', env, [nvmWindowsHome(home, env)], exists) || exists(path.join(nvmWindowsHome(home, env), 'nvm.exe')))
    : exists(nvmShPath(home, env));
  let node24 = false;
  let nodeVersion = '';
  if (typeof execFileSync === 'function') {
    try {
      nodeVersion = String(execFileSync('node', ['-v'], { encoding: 'utf8', timeout: 4000, env: pathEnv })).trim();
      node24 = nodeMajorFromVersion(nodeVersion) >= 24;
    } catch { /* try nvm trees */ }
  }
  if (!node24) {
    const bins = listNode24Bins({
      home, env, platform, exists, readDir: (d) => readdirSync(d),
    });
    if (bins.length) {
      node24 = true;
      nodeVersion = nodeVersion || 'v24';
    }
  }
  const openzoo = Boolean(
    whichOnPath('openzoo', pathEnv, extras, exists)
    || (platform !== 'win32' && exists(path.join(home, '.nvm')) && listNode24Bins({
      home, env, platform, exists, readDir: (d) => { try { return readdirSync(d); } catch { return []; } },
    }).some((nodeBin) => exists(path.join(path.dirname(nodeBin), 'openzoo')))),
  );
  const ready = Boolean(claudePath && node24 && openzoo);
  return {
    platform,
    claude: Boolean(claudePath),
    claudePath: claudePath || null,
    nvm,
    node24,
    nodeVersion,
    openzoo,
    ready,
  };
}

export function persistUnixPath({
  platform = process.platform,
  home = os.homedir(),
  read = readFileSync,
  write = writeFileSync,
  exists = existsSync,
} = {}) {
  if (platform === 'win32') return { wrote: false, reason: 'windows' };
  const line = UNIX_PATH_SNIPPET;
  const names = ['.zprofile', '.zshrc', '.bashrc', '.profile'];
  const wrote = [];
  for (const name of names) {
    const file = path.join(home, name);
    let cur = '';
    try { if (exists(file)) cur = String(read(file, 'utf8')); } catch { cur = ''; }
    if (cur.includes('.local/bin') && cur.includes('PATH')) continue;
    const next = (cur && !cur.endsWith('\n') ? `${cur}\n` : cur) + line + '\n';
    try {
      write(file, next);
      wrote.push(file);
    } catch { /* best-effort */ }
  }
  return { wrote: wrote.length > 0, files: wrote };
}

export function prependHarnessPath(env = process.env, {
  platform = process.platform,
  home = os.homedir(),
  exists = existsSync,
} = {}) {
  const extras = [
    path.join(home, '.local', 'bin'),
    ...claudeCodeBinDirs(home),
  ];
  if (platform === 'win32') {
    extras.push(nvmWindowsHome(home, env));
    extras.push(env.NVM_SYMLINK || path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
  } else {
    extras.push(path.join(env.NVM_DIR || path.join(home, '.nvm')));
    for (const nodeBin of listNode24Bins({
      home, env, platform, exists, readDir: (d) => { try { return readdirSync(d); } catch { return []; } },
    })) {
      extras.push(path.dirname(nodeBin));
    }
  }
  const dirs = [...new Set([...extras.filter(Boolean), ...String(env.PATH || '').split(path.delimiter)])];
  env.PATH = dirs.join(path.delimiter);
  return env.PATH;
}

export function applyOpenzooClaudeSetup({
  env = process.env,
  port = 8402,
  home = os.homedir(),
  write = writeFileSync,
  mkdir = mkdirSync,
} = {}) {
  const zoo = claudeZooEnv(env, { port });
  mkdir(path.join(home, '.openzoo'), { recursive: true });
  write(path.join(home, '.openzoo', 'harness.json'), `${JSON.stringify({
    claudeZoo: true,
    baseUrl: zoo.ANTHROPIC_BASE_URL,
    at: new Date().toISOString(),
  }, null, 2)}\n`);
  env.PATH = zoo.PATH;
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = zoo.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = zoo.ANTHROPIC_AUTH_TOKEN || 'sk-openzoo';
  return zoo;
}

export function unixInstallPlan(missing = {}) {
  const steps = [];
  if (missing.claude) {
    steps.push({
      step: 'claude',
      message: HARNESS_STATUS.claude,
      command: `curl -fsSL ${CLAUDE_UNIX_INSTALL} | bash`,
    });
  }
  if (missing.nvm || missing.node24) {
    const bits = [];
    if (missing.nvm) bits.push(`curl -o- ${NVM_SH_URL} | bash`);
    bits.push('. "$HOME/.nvm/nvm.sh"', 'nvm install 24', 'nvm use 24');
    steps.push({
      step: 'node',
      message: HARNESS_STATUS.node,
      command: bits.join(' && '),
    });
  }
  if (missing.openzoo) {
    steps.push({
      step: 'openzoo',
      message: HARNESS_STATUS.openzoo,
      command: '. "$HOME/.nvm/nvm.sh" && nvm use 24 && npm i -g openzoo',
    });
  }
  steps.push({
    step: 'configure',
    message: HARNESS_STATUS.configure,
    command: 'openzoo claude --setup',
  });
  return steps;
}

export function windowsInstallPlan(missing = {}) {
  const steps = [];
  if (missing.claude) {
    steps.push({
      step: 'claude',
      message: HARNESS_STATUS.claude,
      command: `irm ${CLAUDE_WIN_PS1} | iex`,
    });
  }
  if (missing.nvm) {
    steps.push({
      step: 'node',
      message: HARNESS_STATUS.node,
      command: `nvm-setup.exe ${NVM_WINDOWS_SETUP}`,
    });
  }
  if (missing.nvm || missing.node24) {
    steps.push({
      step: 'node',
      message: HARNESS_STATUS.node,
      command: 'nvm install 24 && nvm use 24',
    });
  }
  if (missing.openzoo) {
    steps.push({
      step: 'openzoo',
      message: HARNESS_STATUS.openzoo,
      command: 'npm i -g openzoo',
    });
  }
  steps.push({
    step: 'configure',
    message: HARNESS_STATUS.configure,
    command: 'openzoo claude --setup',
  });
  return steps;
}

export function installPlan(platform, missing) {
  if (platform === 'win32') return windowsInstallPlan(missing);
  return unixInstallPlan(missing);
}

export function assertPlanSafe(platform, plan) {
  const blob = plan.map((s) => s.command).join('\n');
  if (platform === 'win32') {
    if (/nvm-sh\/nvm/.test(blob)) throw new Error('Windows plan must not curl unix nvm');
    if (/source\s+~\/\.zshrc/.test(blob) || /source\s+"?\$HOME\/\.zshrc/.test(blob)) {
      throw new Error('Windows plan must not source ~/.zshrc');
    }
    if (/claude\.ai\/install\.sh/.test(blob)) throw new Error('Windows plan must not use unix install.sh');
  }
  return true;
}

function runCommand(spawnFn, cmd, args, { env, timeoutMs = 10 * 60 * 1000, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
    });
    let out = '';
    const take = (b) => {
      out += String(b);
      if (out.length > 12000) out = out.slice(-12000);
    };
    if (child.stdout) child.stdout.on('data', take);
    if (child.stderr) child.stderr.on('data', take);
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      reject(new Error(`harness step timed out: ${cmd}`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`harness step exited ${code}: ${cmd}\n${out.slice(-2000)}`));
    });
  });
}

async function runUnixSteps(plan, { spawnFn, env, home }) {
  for (const step of plan) {
    if (step.step === 'configure') continue;
    const script = `export NVM_DIR="$HOME/.nvm"; export PATH="$HOME/.local/bin:$PATH"; ${step.command}`;
    await runCommand(spawnFn, 'bash', ['-lc', script], { env: { ...env, HOME: home } });
  }
}

async function runWindowsSteps(plan, { spawnFn, env, home, missing }) {
  const ps = (command) => runCommand(
    spawnFn,
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: { ...env, HOME: home } },
  );
  for (const step of plan) {
    if (step.step === 'configure') continue;
    if (step.command.startsWith('nvm-setup.exe')) {
      const dest = path.join(os.tmpdir(), 'openzoo-nvm-setup.exe');
      await ps(
        `$ProgressPreference='SilentlyContinue'; `
        + `Invoke-WebRequest -UseBasicParsing -Uri '${NVM_WINDOWS_SETUP}' -OutFile '${dest}'; `
        + `Start-Process -FilePath '${dest}' -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES' -Wait; `
        + `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`,
      );
      continue;
    }
    await ps(step.command);
  }
  void missing;
}

async function ensureHarnessOnce(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const onStatus = opts.onStatus || (() => {});
  const spawnFn = opts.spawn || spawn;

  const set = (step, message, extra = {}) => {
    state = {
      ...state,
      installing: step !== 'ready' && step !== 'error',
      ready: step === 'ready' ? true : state.ready,
      step,
      message,
      error: extra.error || '',
      skipped: Boolean(extra.skipped),
    };
    try { onStatus({ ...state }); } catch { /* paint */ }
  };

  prependHarnessPath(env, { platform, home });
  const detected = detectHarness({
    platform,
    env,
    home,
    execFileSync: opts.execFileSync,
    resolveClaude: opts.resolveClaude,
    exists: opts.exists,
    access: opts.access,
  });
  if (detected.ready) {
    applyOpenzooClaudeSetup({ env, home, port: opts.port });
    set('ready', HARNESS_STATUS.skipped, { skipped: true });
    state.ready = true;
    state.installing = false;
    return { ok: true, skipped: true, detected };
  }

  const missing = {
    claude: !detected.claude,
    nvm: !detected.nvm,
    node24: !detected.node24,
    openzoo: !detected.openzoo,
  };
  const plan = installPlan(platform, missing);
  assertPlanSafe(platform, plan);

  state.installing = true;
  state.ready = false;
  try {
    for (const step of plan) {
      if (step.step === 'configure') continue;
      set(step.step, step.message);
    }
    // Re-emit in order while running so the bar shows the current step.
    const grouped = [];
    for (const step of plan) {
      if (step.step === 'configure') continue;
      const last = grouped[grouped.length - 1];
      if (last && last.step === step.step) last.commands = (last.commands || [last.command]).concat(step.command);
      else grouped.push({ ...step });
    }
    for (const step of grouped) set(step.step, step.message);

    if (platform === 'win32') {
      await runWindowsSteps(plan, { spawnFn, env, home, missing });
    } else {
      await runUnixSteps(plan, { spawnFn, env, home });
      persistUnixPath({ platform, home, write: opts.write, read: opts.read, exists: opts.exists });
    }
    prependHarnessPath(env, { platform, home });
    set('configure', HARNESS_STATUS.configure);
    applyOpenzooClaudeSetup({ env, home, port: opts.port, write: opts.write, mkdir: opts.mkdir });
    if (typeof opts.runOpenzooClaude === 'function') {
      await opts.runOpenzooClaude({ env, home });
    }
    const after = detectHarness({
      platform, env, home,
      execFileSync: opts.execFileSync,
      resolveClaude: opts.resolveClaude,
      exists: opts.exists,
      access: opts.access,
    });
    set('ready', HARNESS_STATUS.ready);
    state.ready = true;
    state.installing = false;
    return { ok: true, skipped: false, detected: after };
  } catch (e) {
    set('error', 'Claude Auto install failed — retry orange Auto.', { error: e.message || String(e) });
    state.installing = false;
    state.ready = false;
    return { ok: false, error: e.message || String(e), detected };
  }
}

/**
 * Detect missing claude / Node 24 / global openzoo and run the
 * platform-correct installer. Safe to call from first paint and from
 * the first orange Auto turn. Concurrent callers share one run.
 */
export function ensureHarness(opts = {}) {
  if (runnerOverride) return Promise.resolve(runnerOverride(opts));
  if (inflight) return inflight;
  inflight = Promise.resolve()
    .then(() => ensureHarnessOnce(opts))
    .finally(() => { inflight = null; });
  return inflight;
}

export function kickHarnessAutostart(opts = {}) {
  if (shouldSkipHarnessAutostart(opts.env || process.env)) return null;
  return ensureHarness(opts);
}
