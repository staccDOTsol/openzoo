#!/usr/bin/env node
// Patch electron-builder 25.1.8's app-builder-lib so `security
// set-key-partition-list` is given the temp keychain's OWN password instead of
// the .p12 password. On newer macOS runner images the old code fails with
//   security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
// because -k must unlock the keychain (created with a random password by
// createKeychain), not re-auth the imported key.
//
// Run AFTER `npm install` (node_modules present), e.g. in CI before `npm run dist:mac`.
// Idempotent: safe to run multiple times.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '../node_modules/app-builder-lib/out/codeSign/macCodeSign.js');
let src = readFileSync(target, 'utf8');
const orig = src;

// 1. Pass the keychain password into importCerts (it's in scope at the call site).
if (src.includes('return await importCerts(keychainFile, certPaths, cscPasswords);')) {
  src = src.replace(
    'return await importCerts(keychainFile, certPaths, cscPasswords);',
    'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);'
  );
} else if (!src.includes('cscPasswords, keychainPassword);')) {
  console.error('[patch-maccodesign] call-site pattern not found — electron-builder changed?');
  process.exit(1);
}

// 2. Accept the keychain password in importCerts.
if (src.includes('async function importCerts(keychainFile, paths, keyPasswords) {')) {
  src = src.replace(
    'async function importCerts(keychainFile, paths, keyPasswords) {',
    'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {'
  );
}

// 3. The actual bug: -k must be the KEYCHAIN password, not the cert password.
const bad = 'await (0, builder_util_1.exec)("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);';
const good = 'await (0, builder_util_1.exec)("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword || password, keychainFile]);';
if (src.includes(bad)) {
  src = src.replace(bad, good);
} else if (!src.includes('keychainPassword || password')) {
  console.error('[patch-maccodesign] set-key-partition-list pattern not found — electron-builder changed?');
  process.exit(1);
}

if (src !== orig) {
  writeFileSync(target, src);
  console.log('[patch-maccodesign] patched macCodeSign.js OK');
} else {
  console.log('[patch-maccodesign] already patched, nothing to do');
}
