// Ad-hoc sign the .app before electron-builder wraps it in a DMG.
//
// CI has no keychain identity, so electron-builder SKIPS macOS signing
// entirely and ships the bundle with the signature Electron's linker wrote
// (Identifier=Electron, flags=adhoc,linker-signed). That signature no longer
// matches the bundle once our files are added, so `codesign --verify --strict`
// fails with "code has no resources but signature indicates they must be
// present" — and macOS reports an INVALID signature as "openzoo is damaged and
// can't be opened", not as "unsigned". Right-click → Open cannot rescue it,
// because the problem is a broken signature rather than an untrusted one.
//
// An ad-hoc signature (`--sign -`) is not notarization and does not remove the
// first-launch prompt, but it makes the bundle structurally valid, so the
// normal right-click → Open path works instead of dead-ending on "damaged".
// arm64 additionally REQUIRES a valid signature to execute at all.
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// COPY THE DEPENDENCY TREE OURSELVES.
//
// electron-builder walks production dependencies to decide what to ship, and
// it kept dropping packages that are plainly declared: the packaged app had 7
// of 13 @solana packages and the bundled proxy died at startup with
//   Cannot find package '@solana/codecs-core'
// on macOS and Windows alike. Adding them as direct dependencies did not fix
// it, and an explicit node_modules glob double-copied and broke the build
// (EEXIST on linux hard links, ENOENT on the mac framework symlink).
//
// A verbatim copy is boring and correct — but it must be of a PRODUCTION-only
// tree. Copying the dev tree drags in electron and electron-builder
// themselves, and codesign then walks so many files it dies with
//   EMFILE: too many open files, open '.../viem/_types/chains/.../bobaSepolia.d.ts'
// So build the production tree once into a staging dir and copy that.
function npmSh(cmd, cwd) {
  // shell:true because on Windows npm is npm.cmd, which execFileSync will not
  // resolve on its own — the win job died with `spawnSync npm ENOENT`.
  execFileSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

function publishedOpenzooVersion() {
  const out = execFileSync('npm view openzoo version', { encoding: 'utf8', shell: true });
  const v = String(out).trim().split(/\s+/).pop();
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`[afterPack] npm view openzoo version returned ${JSON.stringify(out)}`);
  }
  return v;
}

function assertCopiedOpenzoo(dest, published) {
  const want = published || publishedOpenzooVersion();
  const bundled = path.join(dest, 'openzoo', 'package.json');
  if (!fs.existsSync(bundled)) {
    throw new Error('[afterPack] copied node_modules is missing openzoo — nsis/dmg/AppImage would ship no sidecar');
  }
  const got = JSON.parse(fs.readFileSync(bundled, 'utf8')).version;
  if (got !== want) {
    throw new Error(`[afterPack] copied openzoo ${got} !== npm view openzoo version ${want}`);
  }
}

function prodModules(projectDir) {
  const staging = path.join(projectDir, '.prod-modules');
  const stagedNM = path.join(staging, 'node_modules');
  if (!fs.existsSync(stagedNM)) {
    fs.mkdirSync(staging, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) {
      const from = path.join(projectDir, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(staging, f));
    }
    npmSh('npm install --omit=dev --ignore-scripts --no-audit --no-fund', staging);
  }
  // Always re-resolve the published sidecar. Reusing a cached .prod-modules
  // (or a lockfile that still says 0.48.x) is how last week's dmg shipped.
  npmSh('npm install openzoo@latest --omit=dev --ignore-scripts --no-audit --no-fund', staging);
  overlayRepoOpenzooSidecar(stagedNM, projectDir);
  // --ignore-scripts skips dugite's postinstall, which downloads the
  // embedded git. Finder-launched grokui has no ~/.zshrc PATH, so without
  // this binary `git worktree add` dies. Download it explicitly.
  ensureDugiteGit(stagedNM);
  prune(stagedNM);
  return stagedNM;
}

// Unpublished sidecar files must land in node_modules/openzoo even before
// the next npm publish. Packed apps spawn
// node_modules/openzoo/bin/openzoo.js — copyRepoLib → app/lib is the grokui
// UI, not this sidecar. Without these, a dmg still runs npm's 16k spill
// gate. grokui's dep stays "latest"; this overlays the repo tree onto that
// install.
// A filename whitelist that ships livestatus.js without think.js is a
// failed pack (1.5.99: MODULE_NOT_FOUND think.js imported from livestatus.js).
// Overlay the ENTIRE repo lib/ (and bin/), then the vendor extras.
const OPENZOO_SIDECAR_EXTRAS = [
  'vendor/modelroute/catalog.json',
  'vendor/modelroute/router.json',
  'vendor/modelroute/outcomes.json',
  'vendor/modelroute/HANDOFF.md',
  'vendor/modelroute/CURRENT_STATE.md',
];

const OPENZOO_SIDECAR_REQUIRED = [
  'lib/think.js',
  'lib/livestatus.js',
  'lib/relay.js',
  'lib/claudecode.js',
  'lib/launch.js',
  'lib/spill.js',
  'lib/runguard.js',
  'lib/racesettle.js',
  'lib/hrr.js',
  'lib/retrieve.js',
  'lib/proxy.js',
  'bin/openzoo.js',
];

function walkRelFiles(dir, prefix) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkRelFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function listRepoOpenzooOverlay(repoRoot) {
  const lib = walkRelFiles(path.join(repoRoot, 'lib'), 'lib');
  const bin = walkRelFiles(path.join(repoRoot, 'bin'), 'bin');
  return [...new Set([...lib, ...bin, ...OPENZOO_SIDECAR_EXTRAS])];
}

function getOpenzooSidecarOverlay(repoRoot) {
  const repo = repoRoot || path.join(__dirname, '..', '..');
  const listed = listRepoOpenzooOverlay(repo);
  for (const rel of OPENZOO_SIDECAR_REQUIRED) {
    if (!listed.includes(rel)) listed.push(rel);
  }
  return listed;
}

const OPENZOO_SIDECAR_OVERLAY = getOpenzooSidecarOverlay();

function overlayRepoOpenzooSidecar(stagedNM, projectDir) {
  const repo = path.join(projectDir, '..');
  const dest = path.join(stagedNM, 'openzoo');
  if (!fs.existsSync(dest)) return;
  const srcLib = path.join(repo, 'lib');
  const destLib = path.join(dest, 'lib');
  if (!fs.existsSync(srcLib) || !fs.statSync(srcLib).isDirectory()) {
    throw new Error(`[afterPack] overlay source missing: ${srcLib}`);
  }
  fs.cpSync(srcLib, destLib, { recursive: true });
  const srcBin = path.join(repo, 'bin');
  const destBin = path.join(dest, 'bin');
  if (fs.existsSync(srcBin) && fs.statSync(srcBin).isDirectory()) {
    fs.cpSync(srcBin, destBin, { recursive: true });
  }
  for (const rel of OPENZOO_SIDECAR_EXTRAS) {
    const from = path.join(repo, rel);
    if (!fs.existsSync(from)) {
      throw new Error(`[afterPack] overlay source missing: ${from}`);
    }
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(from, out);
  }
  const pkgPath = path.join(dest, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const filesField = Array.isArray(pkg.files) ? pkg.files : [];
    if (!filesField.includes('vendor/modelroute')) {
      pkg.files = [...filesField, 'vendor/modelroute'];
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
  } catch { /* keep published package.json */ }
  assertOverlaidOpenzoo(dest, repo);
  assertPackedOpenzooLib(dest);
}

// Bit-compare packed node_modules/openzoo against the whole repo lib/bin
// plus vendor extras. A version match on package.json is not enough — npm
// latest can still ship the 16k spill while repo lib/spill.js binds at 2k,
// or ship livestatus.js without think.js.
function assertOverlaidOpenzoo(openzooDir, repoRoot) {
  if (!openzooDir || !fs.existsSync(openzooDir)) {
    throw new Error('[afterPack] packed node_modules/openzoo missing — cannot bit-compare overlay');
  }
  const mismatches = [];
  for (const rel of getOpenzooSidecarOverlay(repoRoot)) {
    const from = path.join(repoRoot, rel);
    const got = path.join(openzooDir, rel);
    if (!fs.existsSync(from)) {
      mismatches.push(`${rel}: missing in repo`);
      continue;
    }
    if (!fs.existsSync(got)) {
      mismatches.push(`${rel}: missing in packed openzoo`);
      continue;
    }
    const a = fs.readFileSync(from);
    const b = fs.readFileSync(got);
    if (!a.equals(b)) mismatches.push(`${rel}: packed bytes differ from repo`);
  }
  if (mismatches.length) {
    throw new Error(`[afterPack] packed openzoo is not the overlaid tree:\n${mismatches.join('\n')}`);
  }
  assertPackedLivestatusLoads(openzooDir);
}

// A cut that ships livestatus.js without think.js is a failed pack.
// `node -e "import('./lib/livestatus.js')"` must resolve think.js.
function assertPackedOpenzooLib(openzooDir) {
  if (!openzooDir || !fs.existsSync(openzooDir)) {
    throw new Error('[afterPack] packed node_modules/openzoo missing — cannot assert sidecar lib');
  }
  for (const rel of OPENZOO_SIDECAR_REQUIRED) {
    const got = path.join(openzooDir, rel);
    if (!fs.existsSync(got)) {
      throw new Error(`[afterPack] packed openzoo missing ${rel}`);
    }
  }
  const walker = path.join(__dirname, '..', '..', 'scripts', 'assert-esm-relatives.mjs');
  try {
    execFileSync(process.execPath, [walker, path.join(openzooDir, 'lib', 'livestatus.js')], { encoding: 'utf8' });
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
    throw new Error(`[afterPack] packed openzoo livestatus.js relatives missing:\n${detail}`);
  }
  try {
    execFileSync(process.execPath, ['-e', "import('./lib/livestatus.js')"], {
      cwd: openzooDir,
      encoding: 'utf8',
    });
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
    throw new Error(`[afterPack] packed openzoo cannot import lib/livestatus.js (think.js missing?):\n${detail}`);
  }
}

// livestatus.js imports ./think.js. Overlaying livestatus without think.js
// dies at sidecar boot with ERR_MODULE_NOT_FOUND and the healer used to
// respawn forever. Packed node_modules/openzoo/lib must include think.js
// and a dry import of livestatus must succeed.
function assertPackedLivestatusLoads(openzooDir) {
  const think = path.join(openzooDir, 'lib', 'think.js');
  const live = path.join(openzooDir, 'lib', 'livestatus.js');
  if (!fs.existsSync(think)) {
    throw new Error('[afterPack] packed node_modules/openzoo/lib missing think.js');
  }
  if (!fs.existsSync(live)) {
    throw new Error('[afterPack] packed node_modules/openzoo/lib missing livestatus.js');
  }
  const href = pathToFileURL(live).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', [
    `import { STREAM_IDLE_MS, clipStatusArg } from ${JSON.stringify(href)};`,
    'if (typeof STREAM_IDLE_MS !== "number" || typeof clipStatusArg !== "function") {',
    '  throw new Error("livestatus did not load");',
    '}',
    'console.log("ok packed livestatus load");',
  ].join('\n')], { encoding: 'utf8', cwd: path.join(openzooDir, 'lib') });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || `exit ${r.status}`).trim();
    throw new Error(`[afterPack] packed livestatus cannot load (need think.js next to it):\n${err}`);
  }
}

function ensureDugiteGit(stagedNM) {
  const dugite = path.join(stagedNM, 'dugite');
  const gitBin = process.platform === 'win32'
    ? path.join(dugite, 'git', 'cmd', 'git.exe')
    : path.join(dugite, 'git', 'bin', 'git');
  if (fs.existsSync(gitBin)) return;
  const dl = path.join(dugite, 'script', 'download-git.js');
  if (!fs.existsSync(dl)) {
    console.warn('[afterPack] dugite missing — packaged SPAWN cannot worktree without PATH git');
    return;
  }
  console.log('[afterPack] downloading dugite embedded git (postinstall was skipped)');
  execFileSync(process.execPath, [dl], { cwd: dugite, stdio: 'inherit' });
}

// Drop what is never loaded at runtime. This is not about disk — it is about
// FILE COUNT: codesign --deep walks every file in the bundle and died with
// EMFILE even at a 65535 descriptor limit. viem alone shipped 8,599 files of
// 27,634, the same chain definitions three times over (_esm, _cjs, _types).
// We only ever `import` from viem, so Node resolves the "import" condition and
// _cjs is dead; _types is TypeScript declarations and never loaded at all.
function prune(nm) {
  let removed = 0;
  const rm = (p) => {
    if (!fs.existsSync(p)) return;
    removed += 1;
    fs.rmSync(p, { recursive: true, force: true });
  };
  rm(path.join(nm, 'viem', '_types'));
  rm(path.join(nm, 'viem', '_cjs'));
  // sourcemaps and type declarations across the tree: debugging artefacts that
  // no runtime import can reach.
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.map') || e.name.endsWith('.d.ts') || e.name.endsWith('.d.cts')) rm(full);
    }
  };
  walk(nm);
  console.log(`[afterPack] pruned ${removed} unreachable files/dirs from the production tree`);
}

function packedAppDir(context) {
  return context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
    : path.join(context.appOutDir, 'resources', 'app');
}

// The live UI is repo lib/. A filename whitelist in bundle-grokui.js is
// how 1.5.86 shipped grokui.mjs without info.js and sat on "starting…".
// Copy the ENTIRE directory into Contents/Resources/app/lib (or
// resources/app/lib) so electron-builder's files glob cannot drop a
// newly imported sibling.
function writeLibEsmPackage(dest) {
  // Same file bundle-grokui.js writes. Repo lib/package.json is copied too,
  // but write it here so a stale copy or a missing source file cannot ship
  // another CJS lib/*.js tree (1.5.86 / 1.5.87).
  fs.writeFileSync(path.join(dest, 'package.json'), '{\n  "type": "module"\n}\n');
}

function copyRepoLib(appDir, projectDir) {
  const src = path.join(projectDir, '..', 'lib');
  const dest = path.join(appDir, 'lib');
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`[afterPack] repo lib missing at ${src}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  writeLibEsmPackage(dest);
  console.log(`[afterPack] copied repo lib -> ${dest} (${fs.readdirSync(dest).length} files)`);
}

function assertPackedGrokuiLib(appDir) {
  const entry = path.join(appDir, 'lib', 'grokui.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`[afterPack] packed tree missing ${entry}`);
  }
  const walker = path.join(__dirname, '..', '..', 'scripts', 'assert-esm-relatives.mjs');
  try {
    execFileSync(process.execPath, [walker, entry], { encoding: 'utf8' });
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
    throw new Error(`[afterPack] packed grokui.mjs relatives missing:\n${detail}`);
  }
  const esm = path.join(__dirname, '..', '..', 'scripts', 'assert-packed-grokui-esm.mjs');
  try {
    execFileSync(process.execPath, [esm, path.join(appDir, 'lib')], { encoding: 'utf8' });
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
    throw new Error(`[afterPack] packed lib is not ESM (named imports from .js would fail):\n${detail}`);
  }
}

function extraResourcesDir(context) {
  return context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
}

function archName(arch) {
  if (typeof arch === 'string') return arch;
  const map = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  return map[arch] || process.arch;
}

function walkNativeAddons(dir, found, depth) {
  if (!dir || !fs.existsSync(dir) || depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' && depth > 0) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkNativeAddons(full, found, depth + 1);
    else if (e.name.endsWith('.node')) found.push(full);
  }
}

function findNativeAddons(dir) {
  const found = [];
  walkNativeAddons(dir, found, 0);
  return found;
}

function hasConptyBackend(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  let hit = false;
  const walk = (d, depth) => {
    if (hit || depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (/conpty/i.test(e.name) || /^OpenConsole\.exe$/i.test(e.name)) { hit = true; return; }
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return hit || findNativeAddons(dir).length > 0;
}

function saveRebuiltNatives(appDir) {
  const dest = path.join(appDir, 'node_modules');
  const saved = {};
  for (const name of ['node-pty', 'openzoo-claude']) {
    const from = path.join(dest, name);
    if (!fs.existsSync(from)) continue;
    const tmp = path.join(appDir, `.saved-${name}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(from, tmp, { recursive: true, dereference: true });
    saved[name] = tmp;
  }
  return saved;
}

function restoreRebuiltNatives(appDir, saved) {
  const dest = path.join(appDir, 'node_modules');
  for (const [name, tmp] of Object.entries(saved || {})) {
    if (!tmp || !fs.existsSync(tmp)) continue;
    const out = path.join(dest, name);
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(tmp, out, { recursive: true, dereference: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function copyProjectRuntime(appDir, projectDir) {
  const dest = path.join(appDir, 'node_modules');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['node-pty', 'openzoo-claude']) {
    const out = path.join(dest, name);
    if (fs.existsSync(path.join(out, 'package.json'))) continue;
    const from = path.join(projectDir, 'node_modules', name);
    if (!fs.existsSync(from)) {
      throw new Error(`[afterPack] ${name} is not in grokui-app/node_modules — add it as a real dependency`);
    }
    fs.cpSync(from, out, { recursive: true, dereference: true });
  }
}

function copyRuntimeToExtraResources(context, appDir) {
  const resources = extraResourcesDir(context);
  fs.mkdirSync(resources, { recursive: true });
  for (const name of ['node-pty', 'openzoo-claude']) {
    const from = path.join(appDir, 'node_modules', name);
    if (!fs.existsSync(from)) {
      throw new Error(`[afterPack] cannot copy ${name} to extraResources — missing in packed app`);
    }
    const out = path.join(resources, name);
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(from, out, { recursive: true, dereference: true });
  }
}

function packedElectronBin(context) {
  const product = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${product}.app`, 'Contents', 'MacOS', product);
  }
  if (context.electronPlatformName === 'win32') {
    return path.join(context.appOutDir, `${product}.exe`);
  }
  return path.join(context.appOutDir, product);
}

function assertPackedOpenzooClaude(appDir) {
  const dir = path.join(appDir, 'node_modules', 'openzoo-claude');
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) {
    throw new Error('[afterPack] packed app missing openzoo-claude — dmg/exe/AppImage would have no Auto harness');
  }
  const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  if (json.name !== 'openzoo-claude') {
    throw new Error(`[afterPack] packed openzoo-claude package.json name is ${json.name}`);
  }
  const entry = json.bin && (typeof json.bin === 'string'
    ? json.bin
    : (json.bin['openzoo-claude'] || json.bin.occ || json.bin.claude));
  if (entry && !fs.existsSync(path.join(dir, entry))) {
    throw new Error(`[afterPack] packed openzoo-claude missing bin ${entry}`);
  }
  // Published openzoo-claude@2.0.2 ships slashes in v2/src/ui/commands.mjs
  // (including '/model'). It does not ship v2/src/goal.mjs.
  for (const rel of ['v2/src/ui/commands.mjs']) {
    if (!fs.existsSync(path.join(dir, rel))) {
      throw new Error(`[afterPack] packed openzoo-claude missing ${rel} — OCC slashes must ship in the packed tree`);
    }
  }
  const commands = fs.readFileSync(path.join(dir, 'v2', 'src', 'ui', 'commands.mjs'), 'utf8');
  if (!commands.includes("'/model'")) {
    throw new Error("[afterPack] packed openzoo-claude v2/src/ui/commands.mjs has no '/model' slash");
  }
  const entryAbs = entry ? path.join(dir, entry) : path.join(dir, 'v2', 'src', 'index.mjs');
  if (fs.existsSync(entryAbs)) {
    const check = spawnSync(process.execPath, ['--check', entryAbs], { encoding: 'utf8' });
    if (check.status !== 0) {
      throw new Error(`[afterPack] packed openzoo-claude cannot load (${entryAbs}):\n${(check.stderr || check.stdout || '').trim()}`);
    }
  }
}

function assertPackedVendorXterm(appDir) {
  const vendor = path.join(appDir, 'lib', 'vendor');
  for (const f of ['xterm.js', 'xterm.css', 'fit.js']) {
    if (!fs.existsSync(path.join(vendor, f))) {
      throw new Error(`[afterPack] packed app missing lib/vendor/${f} — Agent TUI cannot load xterm offline`);
    }
  }
}

function assertWindowsConptyFiles(ptyDir) {
  if (!ptyDir || !fs.existsSync(ptyDir)) {
    throw new Error('[afterPack] Windows pack missing node-pty — cannot find conpty.node / OpenConsole.exe');
  }
  let conptyNode = false;
  let openConsole = false;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (/conpty\.node$/i.test(e.name)) conptyNode = true;
      if (/^OpenConsole\.exe$/i.test(e.name)) openConsole = true;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(ptyDir, 0);
  if (!conptyNode || !openConsole) {
    throw new Error('[afterPack] Windows pack missing node-pty conpty.node / OpenConsole.exe');
  }
}

function assertPackedNodePty(appDir, context = {}) {
  const roots = [
    path.join(appDir, 'node_modules', 'node-pty'),
  ];
  if (context.electronPlatformName && context.appOutDir) {
    roots.push(path.join(extraResourcesDir(context), 'node-pty'));
  }
  const ptyDir = roots.find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!ptyDir) {
    throw new Error('[afterPack] packed app missing node-pty — Auto PTY cannot spawn (dmg/exe/AppImage)');
  }
  const addons = findNativeAddons(ptyDir);
  if (!addons.length) {
    const arch = archName(context.arch);
    throw new Error(`[afterPack] packed node-pty missing native .node for ${context.electronPlatformName || process.platform}-${arch}`);
  }
  const plat = context.electronPlatformName || process.platform;
  const targetArch = archName(context.arch);
  const sameArch = !context.arch || targetArch === process.arch || targetArch === 'universal';
  const samePlat = plat === process.platform;
  const electronBin = context.appOutDir ? packedElectronBin(context) : null;
  if (electronBin && fs.existsSync(electronBin) && samePlat && sameArch) {
    const r = spawnSync(electronBin, ['-e', "require('node-pty'); console.log('ok node-pty')"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: appDir,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || `exit ${r.status}`).trim();
      throw new Error(`[afterPack] packed app cannot require('node-pty') via Electron-as-node:\n${detail}`);
    }
  } else if (samePlat && sameArch) {
    const r = spawnSync(process.execPath, ['-e', "require('node-pty'); console.log('ok node-pty')"], {
      cwd: appDir,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || `exit ${r.status}`).trim();
      throw new Error(`[afterPack] packed app cannot require('node-pty'):\n${detail}`);
    }
  }
  if (plat === 'win32') {
    if (!hasConptyBackend(ptyDir)) {
      throw new Error('[afterPack] Windows pack missing node-pty conpty backend');
    }
    assertWindowsConptyFiles(ptyDir);
  }
}

async function rebuildNodePty(appDir, context) {
  const pty = path.join(appDir, 'node_modules', 'node-pty');
  if (!fs.existsSync(pty)) {
    throw new Error('[afterPack] node-pty missing before rebuild');
  }
  if (findNativeAddons(pty).length && context._ptyAlreadyRebuilt) return;
  let rebuild;
  try {
    ({ rebuild } = require('@electron/rebuild'));
  } catch {
    try { ({ rebuild } = require('electron-rebuild')); } catch { rebuild = null; }
  }
  if (!rebuild) {
    if (findNativeAddons(pty).length) return;
    throw new Error('[afterPack] @electron/rebuild missing and node-pty has no native .node');
  }
  const electronVersion = context.electronVersion
    || context.packager.electronVersion
    || context.packager.config?.electronVersion;
  await rebuild({
    buildPath: appDir,
    electronVersion: String(electronVersion || '').replace(/^v/, ''),
    arch: archName(context.arch),
    onlyModules: ['node-pty'],
    force: true,
  });
}

async function ensurePackedPtyAndClaude(context) {
  const appDir = packedAppDir(context);
  copyProjectRuntime(appDir, context.packager.projectDir);
  if (!findNativeAddons(path.join(appDir, 'node_modules', 'node-pty')).length) {
    await rebuildNodePty(appDir, context);
  }
  copyRuntimeToExtraResources(context, appDir);
  assertPackedOpenzooClaude(appDir);
  assertPackedNodePty(appDir, context);
}

function copyNodeModules(context) {
  const src = prodModules(context.packager.projectDir);
  if (!fs.existsSync(src)) {
    throw new Error('[afterPack] production node_modules missing — refusing to pack without openzoo');
  }
  const appDir = packedAppDir(context);
  const dest = path.join(appDir, 'node_modules');
  const saved = saveRebuiltNatives(appDir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  restoreRebuiltNatives(appDir, saved);
  // Hard gate for win nsis / mac dmg / linux AppImage: the copied sidecar
  // must be whatever npm currently publishes, not last week's lockfile.
  assertCopiedOpenzoo(dest);

  // STRIP SYMLINKS THAT ESCAPE THE BUNDLE.
  //
  // Despite dereference:true, cpSync recreates npm's .bin entries as symlinks
  // pointing at the ABSOLUTE source path (…/grokui-app/.prod-modules/…).
  // codesign refuses to sign a bundle containing one:
  //   openzoo.app: invalid destination for symbolic link in bundle
  // and the build dies AFTER packaging, which reads like a signing-identity
  // problem and is not. It only bites where .prod-modules already exists next
  // to the build, which is why a clean CI runner never hit it and the first
  // local build did.
  //
  // .bin holds CLI shims. Electron resolves modules with require(), which
  // never consults .bin, and main.js spawns the proxy by its real path
  // (node_modules/openzoo/bin/openzoo.js), not through the shim. Dropping
  // these is safe; leaving them makes the app unsignable.
  let stripped = 0;
  const strip = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = path.resolve(dir, fs.readlinkSync(p));
        if (!target.startsWith(path.resolve(dest))) { fs.rmSync(p, { force: true }); stripped++; }
      } else if (e.isDirectory()) {
        if (e.name === '.bin') { fs.rmSync(p, { recursive: true, force: true }); stripped++; continue; }
        strip(p);
      }
    }
  };
  strip(dest);

  assertCopiedOpenzoo(dest);
  assertOverlaidOpenzoo(path.join(dest, 'openzoo'), path.join(context.packager.projectDir, '..'));
  assertPackedOpenzooLib(path.join(dest, 'openzoo'));

  const n = fs.readdirSync(path.join(dest, '@solana')).length;
  console.log(`[afterPack] copied production node_modules -> ${dest} (@solana: ${n}, stripped ${stripped} escaping symlink(s)/.bin)`);
}

exports.OPENZOO_SIDECAR_OVERLAY = OPENZOO_SIDECAR_OVERLAY;
exports.OPENZOO_SIDECAR_REQUIRED = OPENZOO_SIDECAR_REQUIRED;
exports.OPENZOO_SIDECAR_EXTRAS = OPENZOO_SIDECAR_EXTRAS;
exports.getOpenzooSidecarOverlay = getOpenzooSidecarOverlay;
exports.listRepoOpenzooOverlay = listRepoOpenzooOverlay;
exports.overlayRepoOpenzooSidecar = overlayRepoOpenzooSidecar;
exports.assertOverlaidOpenzoo = assertOverlaidOpenzoo;
exports.assertPackedOpenzooLib = assertPackedOpenzooLib;
exports.assertPackedLivestatusLoads = assertPackedLivestatusLoads;
exports.assertCopiedOpenzoo = assertCopiedOpenzoo;
exports.publishedOpenzooVersion = publishedOpenzooVersion;
exports.packedAppDir = packedAppDir;
exports.copyRepoLib = copyRepoLib;
exports.writeLibEsmPackage = writeLibEsmPackage;
exports.assertPackedGrokuiLib = assertPackedGrokuiLib;
exports.assertPackedNodePty = assertPackedNodePty;
exports.assertPackedOpenzooClaude = assertPackedOpenzooClaude;
exports.assertPackedVendorXterm = assertPackedVendorXterm;
exports.assertWindowsConptyFiles = assertWindowsConptyFiles;
exports.findNativeAddons = findNativeAddons;
exports.hasConptyBackend = hasConptyBackend;
exports.extraResourcesDir = extraResourcesDir;
exports.ensurePackedPtyAndClaude = ensurePackedPtyAndClaude;

exports.default = async function afterPack(context) {
  const appDir = packedAppDir(context);
  copyRepoLib(appDir, context.packager.projectDir);
  assertPackedGrokuiLib(appDir);
  assertPackedVendorXterm(appDir);
  copyNodeModules(context);
  await ensurePackedPtyAndClaude(context);
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // SKIP THE AD-HOC PASS WHEN A REAL IDENTITY EXISTS.
  //
  // This ad-hoc signature is a FALLBACK for builds with no Apple certificate —
  // without it electron-builder ships an unsigned app that macOS calls
  // "damaged". But when CSC_NAME/CSC_LINK is set, electron-builder signs the
  // very same bundle with the Developer ID immediately afterwards, so the
  // ad-hoc pass is thrown away — and it is not cheap: `codesign --deep` plus
  // `--verify --deep --strict` each walk all ~9,300 files of the bundle
  // (asar is off), for every architecture built.
  const realSigning = Boolean(process.env.CSC_NAME || process.env.CSC_LINK || process.env.CSC_IDENTITY_AUTO_DISCOVERY);
  if (realSigning) {
    console.log('[afterPack] real signing identity present — skipping the ad-hoc pass (electron-builder signs next)');
    return;
  }

  // Helpers and frameworks must be signed before the outer bundle, or the
  // outer signature seals over unsigned nested code. --deep does that ordering.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  // Fail the BUILD rather than ship another "damaged" DMG.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`[afterPack] ad-hoc signed and verified: ${app}`);
};
