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
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

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
  // --ignore-scripts skips dugite's postinstall, which downloads the
  // embedded git. Finder-launched grokui has no ~/.zshrc PATH, so without
  // this binary `git worktree add` dies. Download it explicitly.
  ensureDugiteGit(stagedNM);
  prune(stagedNM);
  return stagedNM;
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

function copyNodeModules(context) {
  const src = prodModules(context.packager.projectDir);
  if (!fs.existsSync(src)) {
    throw new Error('[afterPack] production node_modules missing — refusing to pack without openzoo');
  }
  const appDir = packedAppDir(context);
  const dest = path.join(appDir, 'node_modules');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
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

  const n = fs.readdirSync(path.join(dest, '@solana')).length;
  console.log(`[afterPack] copied production node_modules -> ${dest} (@solana: ${n}, stripped ${stripped} escaping symlink(s)/.bin)`);
}

exports.assertCopiedOpenzoo = assertCopiedOpenzoo;
exports.publishedOpenzooVersion = publishedOpenzooVersion;
exports.packedAppDir = packedAppDir;
exports.copyRepoLib = copyRepoLib;
exports.writeLibEsmPackage = writeLibEsmPackage;
exports.assertPackedGrokuiLib = assertPackedGrokuiLib;

exports.default = async function afterPack(context) {
  const appDir = packedAppDir(context);
  copyRepoLib(appDir, context.packager.projectDir);
  assertPackedGrokuiLib(appDir);
  copyNodeModules(context);
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
