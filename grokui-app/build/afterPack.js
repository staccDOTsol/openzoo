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
function prodModules(projectDir) {
  const staging = path.join(projectDir, '.prod-modules');
  const stagedNM = path.join(staging, 'node_modules');
  if (fs.existsSync(stagedNM)) return stagedNM;
  fs.mkdirSync(staging, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) {
    const from = path.join(projectDir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(staging, f));
  }
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: staging, stdio: 'inherit' });
  return stagedNM;
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
  const n = fs.readdirSync(path.join(dest, '@solana')).length;
  console.log(`[afterPack] copied production node_modules -> ${dest} (@solana: ${n})`);
}

exports.default = async function afterPack(context) {
  copyNodeModules(context);
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Helpers and frameworks must be signed before the outer bundle, or the
  // outer signature seals over unsigned nested code. --deep does that ordering.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  // Fail the BUILD rather than ship another "damaged" DMG.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`[afterPack] ad-hoc signed and verified: ${app}`);
};
