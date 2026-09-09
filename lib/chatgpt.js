/**
 * `npx openzoo chatgpt` — OpenAI's ChatGPT desktop app on the zoo.
 *
 * Configures an isolated Codex home, installs the current official app when
 * missing, starts the local proxy and launches the app with that configuration.
 * Custom provider routing applies to Codex; ordinary ChatGPT chats still use
 * chatgpt.com. No TryOmarchy or third-party app distribution is involved.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { launchWindowsPackage } from './windows-chatgpt.js';
import { startChatGptSpend } from './chatgpt-spend.js';
import { installChatGpt, windowsChatGptApp, runCommand } from './chatgpt-install.js';

export const PROVIDER_ID = 'openzoo';
export const API_KEY_ENV = 'OPENZOO_API_KEY';
export const API_KEY_VALUE = 'sk-openzoo'; // any value: the zoo takes payment, not keys

/** Codex's home: $CODEX_HOME, else ~/.codex. */
export function codexHome(env = process.env, home = os.homedir()) {
  return env.CODEX_HOME || path.join(home, '.codex');
}

export function codexConfigPath(env = process.env, home = os.homedir()) {
  return path.join(codexHome(env, home), 'config.toml');
}

export function defaultModel(env = process.env) {
  // DEEPSEEK BY DEFAULT. The person running `openzoo chatgpt` has not chosen
  // a model and mostly will not: the default is what they pay for on every
  // turn until they type /model. It used to be claude-opus-5, the most
  // expensive door in the catalog, so the "much less spend" pitch shipped
  // with the priciest setting turned on. deepseek-v4-flash is a fraction of
  // a cent per million tokens in, carries a 1M-token window, and is a bare
  // id the doors serve directly. Anyone who wants more says /model.
  // Bare ids are what the doors serve; the gateway resolves the rest.
  return env.OPENZOO_DEFAULT_MODEL || 'deepseek-v4-flash';
}

/**
 * The provider table Codex reads. `wire_api = "responses"` because the local
 * proxy forwards POST /v1/responses as a paid path (lib/proxy.js) and that is
 * what Codex speaks natively; `--wire chat` is there for a build that only
 * does chat completions. `bearer` writes a static token instead of an env
 * key, for launches this command does not control (a desktop launcher).
 */
export function providerBlock({ port = config.port, wireApi = 'responses', bearer = false } = {}) {
  const lines = [
    `[model_providers.${PROVIDER_ID}]`,
    `name = "${PROVIDER_ID}"`,
    `base_url = "http://localhost:${port}/v1"`,
    `wire_api = "${wireApi}"`,
    bearer ? `experimental_bearer_token = "${API_KEY_VALUE}"` : `env_key = "${API_KEY_ENV}"`,
    'requires_openai_auth = false',
  ];
  return `${lines.join('\n')}\n`;
}

const isTableHeader = (line) => /^\s*\[/.test(line);
const OUR_TABLE = new RegExp(`^\\s*\\[model_providers\\.${PROVIDER_ID}\\]\\s*$`);
const OUR_MARK = '# written by `npx openzoo chatgpt` — rerun it to refresh, edit freely otherwise';

/**
 * Merge our provider into an existing config.toml TEXT. Pure.
 *
 * TOML puts top-level keys before the first table, so `model` and
 * `model_provider` are (re)written at the very top and any earlier copies of
 * those two keys in the top-level span are dropped. Our own table is replaced
 * wholesale — it is generated, and a stale half-merge is worse than none.
 * Every other line, table and comment is preserved byte-for-byte. Running
 * this twice yields identical text.
 */
export function mergeCodexConfig(existing, { model, port, wireApi, bearer } = {}) {
  const src = String(existing || '').replace(/\r\n/g, '\n');
  const lines = src === '' ? [] : src.split('\n');

  // 1. drop our previous table (header through the line before the next header)
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (OUR_TABLE.test(line)) { skipping = true; continue; }
    if (skipping && isTableHeader(line)) skipping = false;
    if (skipping) continue;
    if (line.trim() === OUR_MARK) continue;
    kept.push(line);
  }

  // 2. split into the top-level span and the tables that follow
  const firstTable = kept.findIndex(isTableHeader);
  const top = firstTable === -1 ? kept : kept.slice(0, firstTable);
  const tables = firstTable === -1 ? [] : kept.slice(firstTable);

  // 3. our two keys lead; earlier copies go
  const ours = new Set(['model', 'model_provider']);
  const topRest = top.filter((line) => {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    return !(m && ours.has(m[1]));
  });
  const head = [
    OUR_MARK,
    `model = ${JSON.stringify(model || defaultModel())}`,
    `model_provider = "${PROVIDER_ID}"`,
  ];
  // trim blank padding so reruns do not accumulate empty lines
  const trimBlank = (arr) => {
    const out = [...arr];
    while (out.length && out[0].trim() === '') out.shift();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    return out;
  };
  const parts = [head.join('\n')];
  const restTop = trimBlank(topRest);
  if (restTop.length) parts.push(restTop.join('\n'));
  const restTables = trimBlank(tables);
  if (restTables.length) parts.push(restTables.join('\n'));
  parts.push(providerBlock({ port, wireApi, bearer }).trimEnd());
  return `${parts.join('\n\n')}\n`;
}

/** Candidate app binaries, most specific first. Exported for tests. */
export function chatGptCandidates({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path;
  const out = [];
  if (env.OPENZOO_CHATGPT_BIN) out.push(env.OPENZOO_CHATGPT_BIN);
  if (platform === 'darwin') {
    out.push('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
    out.push(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'));
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local');
    out.push(paths.join(local, 'Programs', 'ChatGPT', 'ChatGPT.exe'));
  } else {
    // the .deb's layout (apt install), then where THIS command unpacks it,
    // then the by-hand unpack path the first Arch run used
    out.push('/usr/lib/chatgpt/ChatGPT');
    out.push('/opt/ChatGPT/chatgpt');
    out.push(path.join(unpackDir(home), 'usr', 'lib', 'chatgpt', 'ChatGPT'));
    out.push(path.join(home, 'apps', 'chatgpt', 'usr', 'lib', 'chatgpt', 'ChatGPT'));
  }
  for (const dir of String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    out.push(paths.join(dir, platform === 'win32' ? 'chatgpt.exe' : 'chatgpt'));
  }
  return out;
}

export function resolveChatGptApp(opts = {}) {
  const exists = opts.exists || ((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  return chatGptCandidates(opts).find(p => {
    if (!exists(p)) return false;
    if ((opts.platform || process.platform) === 'darwin' && p.endsWith('/Contents/MacOS/ChatGPT')) {
      return exists(path.resolve(path.dirname(p), '../Resources/codex'));
    }
    return true;
  }) || null;
}

/** Where `--deb` (or an auto-found download) is unpacked. */
export function unpackDir(home = os.homedir()) {
  return path.join(home, '.openzoo', 'apps', 'chatgpt');
}

/** Newest chatgpt*.deb in ~/Downloads, or null. */
export function findDownloadedDeb(home = os.homedir()) {
  const dir = path.join(home, 'Downloads');
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const debs = names
    .filter((n) => /^chatgpt.*\.deb$/i.test(n))
    .map((n) => path.join(dir, n))
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return debs.length ? debs[0].p : null;
}

function have(bin) {
  return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== null;
}

/**
 * Unpack a .deb without dpkg: a .deb is an `ar` archive holding data.tar.*.
 * bsdtar reads both layers; `ar` + `tar` is the fallback. Returns the app
 * binary path inside `dest`.
 */
export function unpackDeb(deb, dest = unpackDir()) {
  if (!fs.existsSync(deb)) throw new Error(`no such file: ${deb}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'openzoo-deb-'));
  const staged = fs.mkdtempSync(path.join(path.dirname(dest), '.chatgpt-unpack-'));
  const run = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.error?.message || String(r.stderr || '').trim().slice(0, 200)}`);
  };
  try {
    if (have('bsdtar')) run('bsdtar', ['-xf', deb], outer);
    else if (have('ar')) run('ar', ['x', deb], outer);
    else throw new Error('need bsdtar (libarchive) or ar (binutils) to unpack a .deb');
    const data = fs.readdirSync(outer).find((n) => /^data\.tar/.test(n));
    if (!data) throw new Error('not a .deb: no data.tar inside');
    run('tar', ['-xf', path.join(outer, data), '-C', staged]);
    const relative = path.join('usr', 'lib', 'chatgpt', 'ChatGPT');
    if (!fs.existsSync(path.join(staged, relative))) throw new Error('package does not contain the ChatGPT desktop executable');
    fs.accessSync(path.join(staged, relative), fs.constants.X_OK);
    // Do not erase a previous unpack until the replacement has been validated.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staged, dest);
    return path.join(dest, relative);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

async function ensureProxy({ tunnel }) {
  const { oursOn, packageVersion } = await import('./proxy.js');
  if (await oursOn(config.port)) return { started: false };
  // DETACHED, like `openzoo aoe`: the app outlives this command, so the
  // proxy must too. No public tunnel unless asked — a detached proxy nobody
  // watches must not open a URL + key that spends the wallet.
  const logPath = path.join(os.homedir(), '.openzoo', 'proxy.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const env = { ...process.env };
  if (!tunnel && !env.OPENZOO_NO_TUNNEL) env.OPENZOO_NO_TUNNEL = '1';
  const child = spawn(process.execPath, [process.argv[1], 'proxy'], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env });
  child.unref();
  fs.closeSync(fd);
  process.stderr.write(`openzoo: starting the proxy (v${packageVersion()}) in the background, log ${logPath}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stderr.write('.');
    try {
      if (await oursOn(config.port)) { process.stderr.write('\n'); return { started: true, logPath }; }
    } catch { /* not yet */ }
  }
  process.stderr.write('\n');
  throw new Error(`proxy did not answer on :${config.port} within 60s — see ${logPath}`);
}

/**
 * `npx openzoo chatgpt [--model <id>] [--deb <file>] [--wire responses|chat]
 *                      [--bearer] [--no-launch] [--no-proxy] [--tunnel] [--print]`
 */
export async function setupChatGpt(argv = [], dependencies = {}) {
  const { platform = process.platform, home = os.homedir(), env: sourceEnv = process.env,
    resolve = resolveChatGptApp, install = installChatGpt, proxy = ensureProxy,
    launch = launchChatGpt, findWindows = windowsChatGptApp, overlay = startChatGptSpend } = dependencies;
  const args = [...argv];
  const opt = { model: null, deb: null, wireApi: 'responses', bearer: false, launch: true, proxy: true, pill: true, tunnel: false, print: false, configPath: null, rest: [] };
  while (args.length) {
    const a = args.shift();
    if (a === '--') { opt.rest.push(...args); break; }
    const value = () => {
      if (!args.length || args[0].startsWith('--') || !args[0].trim()) throw new Error(`${a} requires a value`);
      return args.shift().trim();
    };
    if (a === '--model') opt.model = value();
    else if (a === '--deb') opt.deb = value();
    else if (a === '--wire') opt.wireApi = value();
    else if (a === '--config') opt.configPath = value();
    else if (a === '--bearer') opt.bearer = true;
    else if (a === '--no-launch') opt.launch = false;
    else if (a === '--no-pill') opt.pill = false;
    else if (a === '--no-proxy') opt.proxy = false;
    else if (a === '--tunnel') opt.tunnel = true;
    else if (a === '--print') opt.print = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opt.rest.push(a);
  }
  if (!['responses', 'chat'].includes(opt.wireApi)) throw new Error('--wire must be responses or chat');
  if (opt.deb && platform !== 'linux') throw new Error('--deb is only supported on Linux');
  const model = opt.model || defaultModel(sourceEnv);
  const merge = { model, port: config.port, wireApi: opt.wireApi, bearer: opt.bearer };

  if (opt.print) {
    process.stdout.write(mergeCodexConfig('', merge));
    return { printed: true };
  }

  // 1. config.toml
  const appHome = sourceEnv.CODEX_HOME || path.join(home, '.openzoo', 'chatgpt');
  const file = path.resolve(opt.configPath || path.join(appHome, 'config.toml'));
  if (path.basename(file) !== 'config.toml') throw new Error('--config must name config.toml (the filename Codex reads)');
  let existing = '';
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf8');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const next = mergeCodexConfig(existing, merge);
  if (next !== existing) {
    if (existing && !fs.existsSync(`${file}.openzoo-backup`)) fs.copyFileSync(file, `${file}.openzoo-backup`);
    fs.writeFileSync(file, next);
  }
  console.log(`${next !== existing ? 'wrote' : 'kept'} ${file}: model_provider = "${PROVIDER_ID}" (http://localhost:${config.port}/v1, ${opt.wireApi}), model = "${model}"`);

  if (!opt.launch) {
    console.log('config only; no download, installation, proxy or app launch.');
    return { file, model, launched: false };
  }

  // Reuse an installation before attempting any download.
  let app = resolve({ env: sourceEnv, home, platform });
  if (!app && sourceEnv.OPENZOO_CHATGPT_BIN) throw new Error(`OPENZOO_CHATGPT_BIN is not an executable ChatGPT app: ${sourceEnv.OPENZOO_CHATGPT_BIN}`);
  if (!app && platform === 'win32') app = await findWindows();
  if (!app && platform === 'linux' && opt.deb) app = unpackDeb(path.resolve(opt.deb), unpackDir(home));
  if (!app) app = await install({ platform, home, unpack: unpackDeb });

  if (opt.proxy) {
    const p = await proxy({ tunnel: opt.tunnel });
    console.log(p.started ? `proxy up on :${config.port} (background)` : `proxy already on :${config.port}`);
  }

  // 4. launch, with the env var the provider's env_key names
  const env = { ...sourceEnv, [API_KEY_ENV]: sourceEnv[API_KEY_ENV] || API_KEY_VALUE,
    CODEX_HOME: path.dirname(file),
    CODEX_ELECTRON_USER_DATA_PATH: path.join(path.dirname(file), 'desktop'),
  };
  console.log(`launching ${app}`);
  console.log(`  Codex / agent mode → the zoo, paid per turn by x402. Choose "sign in with API key" (any key).`);
  console.log('  the plain ChatGPT chat tab still talks to chatgpt.com — that half is not API-shaped.');
  const appArgs = opt.pill ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', ...opt.rest] : opt.rest;
  await launch(app, appArgs, { env, platform });
  if (opt.pill) {
    try {
      await overlay({ profile: env.CODEX_ELECTRON_USER_DATA_PATH, proxyPort: config.port });
      console.log('savings pill enabled · spent / estimated direct cost / saved · shared proxy totals');
    } catch (e) { console.error(`openzoo: savings pill unavailable: ${e.message}`); }
  }
  return { file, model, app, launched: true };
}

/** LaunchServices handles app bundles on macOS; detect early failures elsewhere. */
export async function launchChatGpt(app, args, { env, platform = process.platform, run = runCommand, spawnImpl = spawn } = {}) {
  if (platform === 'win32' && /[\\/]WindowsApps[\\/]/i.test(app)) {
    await launchWindowsPackage(app, args, { env, run });
    return;
  }
  if (platform === 'darwin' && app.endsWith('/Contents/MacOS/ChatGPT')) {
    await run('open', ['-n', '--env', `CODEX_HOME=${env.CODEX_HOME}`,
      '--env', `CODEX_ELECTRON_USER_DATA_PATH=${env.CODEX_ELECTRON_USER_DATA_PATH}`,
      '--env', `${API_KEY_ENV}=${env[API_KEY_ENV]}`,
      app.slice(0, -'/Contents/MacOS/ChatGPT'.length), '--args',
      `--user-data-dir=${env.CODEX_ELECTRON_USER_DATA_PATH}`, ...args], { env });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawnImpl(app, [`--user-data-dir=${env.CODEX_ELECTRON_USER_DATA_PATH}`, ...args], { stdio: 'ignore', env, detached: true });
    const timer = setTimeout(() => { child.unref(); resolve(); }, 1500);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(); // an existing instance accepted the launch
      else reject(new Error(`ChatGPT exited during launch (${signal || code})`));
    });
  });
}
