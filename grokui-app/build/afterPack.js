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
function wantedOpenzooVersion(projectDir) {
  const app = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  const declared = String(app.dependencies?.openzoo || '').replace(/^[^\d]*/, '');
  const rootPath = path.join(projectDir, '..', 'package.json');
  if (fs.existsSync(rootPath)) {
    const root = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
    if (root.name === 'openzoo' && root.version) return String(root.version);
  }
  return declared;
}

function readOpenzooVersion(nmDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(nmDir, 'openzoo', 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}

function assertOpenzooVersion(nmDir, want, where) {
  const have = readOpenzooVersion(nmDir);
  if (have !== want) {
    throw new Error(`[afterPack] ${where}: bundled openzoo is ${have || 'missing'}, want ${want}. Refusing to pack a stale sidecar.`);
  }
}

function prodModules(projectDir) {
  const staging = path.join(projectDir, '.prod-modules');
  const stagedNM = path.join(staging, 'node_modules');
  const want = wantedOpenzooVersion(projectDir);
  if (fs.existsSync(stagedNM)) {
    const have = readOpenzooVersion(stagedNM);
    if (have === want) return stagedNM;
    console.warn(`[afterPack] stale .prod-modules openzoo ${have || 'missing'} (want ${want}) — reinstalling`);
    fs.rmSync(staging, { recursive: true, force: true });
  }
  fs.mkdirSync(staging, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) {
    const from = path.join(projectDir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(staging, f));
  }
  // shell:true because on Windows npm is npm.cmd, which execFileSync will not
  // resolve on its own — the win job died with `spawnSync npm ENOENT`.
  execFileSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund',
    { cwd: staging, stdio: 'inherit', shell: true });
  // --ignore-scripts skips dugite's postinstall, which downloads the
  // embedded git. Finder-launched grokui has no ~/.zshrc PATH, so without
  // this binary `git worktree add` dies. Download it explicitly.
  ensureDugiteGit(stagedNM);
  prune(stagedNM);
  assertOpenzooVersion(stagedNM, want, '.prod-modules');
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

function copyNodeModules(context) {
  const src = prodModules(context.packager.projectDir);
  if (!fs.existsSync(src)) return;
  const appDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
    : path.join(context.appOutDir, 'resources', 'app');
  const dest = path.join(appDir, 'node_modules');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });

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

  const n = fs.readdirSync(path.join(dest, '@solana')).length;
  const want = wantedOpenzooVersion(context.packager.projectDir);
  assertOpenzooVersion(dest, want, dest);
  console.log(`[afterPack] copied production node_modules -> ${dest} (@solana: ${n}, openzoo ${want}, stripped ${stripped} escaping symlink(s)/.bin)`);
}

exports.default = async function afterPack(context) {
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
