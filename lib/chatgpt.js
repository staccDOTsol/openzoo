/**
 * `npx openzoo chatgpt` — OpenAI's ChatGPT desktop app on the zoo.
 *
 * The Linux preview of the official app (chatgpt.com/download, August 2026)
 * ships the Codex engine inside it: `usr/lib/chatgpt/resources/codex`, and
 * `usr/bin/chatgpt` is a symlink named `codex-launcher`. That engine reads a
 * standard Codex config — `$CODEX_HOME/config.toml`, default `~/.codex` — and
 * its `[model_providers.<id>]` table is the supported way to point it at any
 * OpenAI-shaped server. MEASURED 2026-09-09 on the .deb's `codex` binary:
 * the strings `model_providers`, `env_key`, `requires_openai_auth`,
 * `experimental_bearer_token`, `responses` and `https://api.openai.com/v1`
 * (as a default, next to `ollama` and `amazon-bedrock`) are all there, and
 * a provider block pointed at :8402 answered in the app.
 *
 * What this does and does not redirect, so nobody is surprised:
 *   - the Codex / agent side of the app ("sign in with API key") → the zoo,
 *     paid per turn by x402 through the local proxy;
 *   - the plain ChatGPT conversation tab → still chatgpt.com. It talks to
 *     `chatgpt_base_url = "https://chatgpt.com/backend-api/"`, a private
 *     backend that is not API-shaped, so there is nothing to point at us.
 *   - the two auth modes are exclusive: the binary logs "ChatGPT login is
 *     required, but an API key is currently being used. Logging out." Pick
 *     API-key mode for the session that should pay x402.
 *
 * One command, end to end: write the provider into config.toml (backing up
 * the old file, keeping every other table), make sure a proxy is listening,
 * find the app — or unpack the downloaded .deb on a distro that cannot
 * install it, which is how this was first done on Arch — and launch it with
 * the env var the provider's `env_key` names.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

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
  // Bare ids are what the doors serve; the gateway resolves the rest.
  return env.OPENZOO_DEFAULT_MODEL || 'claude-opus-5';
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
    `model = "${model || defaultModel()}"`,
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
  const out = [];
  if (env.OPENZOO_CHATGPT_BIN) out.push(env.OPENZOO_CHATGPT_BIN);
  if (platform === 'darwin') {
    out.push('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
    out.push(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'));
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(local, 'Programs', 'ChatGPT', 'ChatGPT.exe'));
  } else {
    // the .deb's layout (apt install), then where THIS command unpacks it,
    // then the by-hand unpack path the first Arch run used
    out.push('/usr/lib/chatgpt/ChatGPT');
    out.push('/opt/ChatGPT/chatgpt');
    out.push(path.join(unpackDir(home), 'usr', 'lib', 'chatgpt', 'ChatGPT'));
    out.push(path.join(home, 'apps', 'chatgpt', 'usr', 'lib', 'chatgpt', 'ChatGPT'));
  }
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    out.push(path.join(dir, platform === 'win32' ? 'chatgpt.exe' : 'chatgpt'));
  }
  return out;
}

export function resolveChatGptApp(opts = {}) {
  const exists = opts.exists || ((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  return chatGptCandidates(opts).find(exists) || null;
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
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'openzoo-deb-'));
  const run = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${String(r.stderr || '').trim().slice(0, 200)}`);
  };
  if (have('bsdtar')) run('bsdtar', ['-xf', deb], outer);
  else if (have('ar')) run('ar', ['x', deb], outer);
  else throw new Error('need bsdtar (libarchive) or ar (binutils) to unpack a .deb');
  const data = fs.readdirSync(outer).find((n) => /^data\.tar/.test(n));
  if (!data) throw new Error('not a .deb: no data.tar inside');
  run('tar', ['-xf', path.join(outer, data), '-C', dest]);
  fs.rmSync(outer, { recursive: true, force: true });
  const app = path.join(dest, 'usr', 'lib', 'chatgpt', 'ChatGPT');
  if (!fs.existsSync(app)) throw new Error(`unpacked, but ${app} is not there — not the ChatGPT .deb?`);
  return app;
}

async function ensureProxy({ tunnel }) {
  const { startProxy, oursOn, packageVersion } = await import('./proxy.js');
  if (await oursOn(config.port)) return { started: false };
  // DETACHED, like `openzoo aoe`: the app outlives this command, so the
  // proxy must too. No public tunnel unless asked — a detached proxy nobody
  // watches must not open a URL + key that spends the wallet.
  const logPath = path.join(os.homedir(), '.openzoo', 'proxy.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const env = { ...process.env };
  if (!tunnel && !env.OPENZOO_NO_TUNNEL) env.OPENZOO_NO_TUNNEL = '1';
  const child = spawn(process.execPath, [process.argv[1], 'proxy'], { detached: true, stdio: ['ignore', fd, fd], env });
  child.unref();
  fs.closeSync(fd);
  process.stderr.write(`openzoo: starting the proxy (v${packageVersion()}) in the background, log ${logPath}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stderr.write('.');
    try {
      const r = await fetch(`http://localhost:${config.port}/v1/info`);
      if (r.ok) { process.stderr.write('\n'); return { started: true, logPath }; }
    } catch { /* not yet */ }
  }
  process.stderr.write('\n');
  throw new Error(`proxy did not answer on :${config.port} within 60s — see ${logPath}`);
}

const INSTALL_HELP = `openzoo: ChatGPT desktop app not found.
  download it from https://chatgpt.com/download (Linux: the .deb; macOS/Windows: the installer), then:
    Debian/Ubuntu:  sudo apt install ./chatgpt_amd64.deb
    Fedora:         sudo dnf install ./chatgpt*.rpm
    Arch / other:   npx openzoo chatgpt --deb ~/Downloads/chatgpt_amd64.deb   (unpacked, no dpkg needed)
  or point OPENZOO_CHATGPT_BIN at the binary.`;

/**
 * `npx openzoo chatgpt [--model <id>] [--deb <file>] [--wire responses|chat]
 *                      [--bearer] [--no-launch] [--no-proxy] [--tunnel] [--print]`
 */
export async function setupChatGpt(argv = []) {
  const args = [...argv];
  const opt = { model: null, deb: null, wireApi: 'responses', bearer: false, launch: true, proxy: true, tunnel: false, print: false, configPath: null, rest: [] };
  while (args.length) {
    const a = args.shift();
    if (a === '--model') opt.model = String(args.shift() || '').trim() || null;
    else if (a === '--deb') opt.deb = String(args.shift() || '').trim() || null;
    else if (a === '--wire') opt.wireApi = String(args.shift() || '').trim();
    else if (a === '--config') opt.configPath = String(args.shift() || '').trim() || null;
    else if (a === '--bearer') opt.bearer = true;
    else if (a === '--no-launch') opt.launch = false;
    else if (a === '--no-proxy') opt.proxy = false;
    else if (a === '--tunnel') opt.tunnel = true;
    else if (a === '--print') opt.print = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opt.rest.push(a);
  }
  if (!['responses', 'chat'].includes(opt.wireApi)) throw new Error('--wire must be responses or chat');
  const model = opt.model || defaultModel();
  const merge = { model, port: config.port, wireApi: opt.wireApi, bearer: opt.bearer };

  if (opt.print) {
    process.stdout.write(mergeCodexConfig('', merge));
    return { printed: true };
  }

  // 1. config.toml
  const file = opt.configPath || codexConfigPath();
  let existing = '';
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf8');
    fs.copyFileSync(file, `${file}.openzoo-backup`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const next = mergeCodexConfig(existing, merge);
  if (next !== existing) fs.writeFileSync(file, next);
  console.log(`${next !== existing ? 'wrote' : 'kept'} ${file}: model_provider = "${PROVIDER_ID}" (http://localhost:${config.port}/v1, ${opt.wireApi}), model = "${model}"`);

  // 2. proxy
  if (opt.proxy) {
    const p = await ensureProxy({ tunnel: opt.tunnel });
    console.log(p.started ? `proxy up on :${config.port} (background)` : `proxy already on :${config.port}`);
  }

  if (!opt.launch) {
    console.log(`config only. launch the app with ${API_KEY_ENV}=${API_KEY_VALUE} in its environment and pick "sign in with API key".`);
    return { file, model, launched: false };
  }

  // 3. the app
  let app = resolveChatGptApp();
  if (!app && process.platform === 'linux') {
    const deb = opt.deb || findDownloadedDeb();
    if (deb) {
      console.log(`unpacking ${deb} into ${unpackDir()} (no dpkg needed)`);
      app = unpackDeb(deb);
    }
  } else if (opt.deb) {
    app = unpackDeb(opt.deb);
  }
  if (!app) {
    console.error(INSTALL_HELP);
    process.exitCode = 1;
    return { file, model, launched: false };
  }

  // 4. launch, with the env var the provider's env_key names
  const env = { ...process.env, [API_KEY_ENV]: process.env[API_KEY_ENV] || API_KEY_VALUE };
  if (!env.CODEX_HOME) env.CODEX_HOME = codexHome();
  console.log(`launching ${app}`);
  console.log(`  Codex / agent mode → the zoo, paid per turn by x402. Choose "sign in with API key" (any key).`);
  console.log('  the plain ChatGPT chat tab still talks to chatgpt.com — that half is not API-shaped.');
  const child = spawn(app, opt.rest, { stdio: 'ignore', env, detached: true });
  child.on('error', (e) => console.error(`openzoo: could not launch ${app}: ${e.message}`));
  child.unref();
  return { file, model, app, launched: true };
}
