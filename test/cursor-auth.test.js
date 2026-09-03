import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCursorJwt, fakeCursorTokens, fakeCursorAuthReply } from '../lib/cursorapi.js';
import {
  grokBotLaunchEnv,
  sandDescriptorKey,
  sandAccountKey,
  grokBotUserDataDirs,
  claimGrokBotMachine,
} from '../lib/grokcli.js';

function jwtPayload(tok) {
  return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
}

test('fake JWT has sub/email/exp so createLoggedInStatus is logged-in', () => {
  const t = fakeCursorJwt({ now: 1_700_000_000 });
  const p = jwtPayload(t);
  assert.equal(p.sub, 'openzoo-user');
  assert.equal(p.email, 'user@openzoo.local');
  assert.ok(p.exp > 1_700_000_000);
});

test('auth/poll returns accessToken+refreshToken (asar waitForResult success)', () => {
  const r = fakeCursorAuthReply('/auth/poll?uuid=abc&verifier=xyz');
  assert.equal(r.kind, 'poll');
  const j = JSON.parse(r.body);
  assert.ok('accessToken' in j);
  assert.ok('refreshToken' in j);
  assert.equal(j.authId, 'openzoo-user');
  assert.equal(jwtPayload(j.accessToken).email, 'user@openzoo.local');
});

test('oauth/token returns snake_case tokens (asar pue schema)', () => {
  const r = fakeCursorAuthReply('/oauth/token');
  assert.equal(r.kind, 'oauth');
  const j = JSON.parse(r.body);
  assert.ok(j.access_token);
  assert.ok(j.refresh_token);
  assert.equal(j.token_type, 'Bearer');
});

test('loginDeepControl is a local logged-in page, not cursor.com', () => {
  const r = fakeCursorAuthReply('/loginDeepControl?challenge=x');
  assert.equal(r.kind, 'login-page');
  assert.match(r.body, /logged in/i);
});

test('passthrough/sniff does not fake login', () => {
  assert.equal(fakeCursorAuthReply('/auth/poll', { passthrough: true }), null);
});

test('empty {} is NOT a valid poll body (that was the Linux login wall)', () => {
  const r = fakeCursorAuthReply('/auth/poll');
  const j = JSON.parse(r.body);
  assert.notEqual(Object.keys(j).length, 0);
  assert.ok(!('accessToken' in JSON.parse('{}')));
});

test('Grok Bot launch env points website login at the hijack', () => {
  const env = grokBotLaunchEnv('https://127.0.0.1:8443', { HOME: '/tmp' });
  assert.equal(env.SAND_CURSOR_WEBSITE_URL, 'https://127.0.0.1:8443');
  assert.equal(env.CURSOR_WEBSITE_URL, 'https://127.0.0.1:8443');
  assert.equal(env.SAND_DEV_ALLOW_ACCOUNT_REBIND, '1');
});

test('asar descriptorKey canonicalizes the hijack URL (trailing slash)', () => {
  const want = createHash('sha256')
    .update('sand-env-descriptor').update('\0').update('https://127.0.0.1:8443/')
    .digest('hex');
  assert.equal(sandDescriptorKey('https://127.0.0.1:8443'), want);
  assert.equal(sandDescriptorKey('https://127.0.0.1:8443/'), want);
  assert.match(want, /^[a-f0-9]{64}$/);
});

test('asar accountKey is sha256(sand-account-slot || 0x00 || openzoo-user)', () => {
  const want = createHash('sha256')
    .update('sand-account-slot').update('\0').update('openzoo-user')
    .digest('hex');
  assert.equal(sandAccountKey(), want);
  assert.equal(sandAccountKey('openzoo-user'), want);
});

test('Linux userData is ~/.config/Grok Bot (Electron productName)', () => {
  const dirs = grokBotUserDataDirs('/home/u', {}, 'linux');
  assert.ok(dirs.includes('/home/u/.config/Grok Bot'));
  assert.ok(dirs.includes('/home/u/.config/sand'));
});

test('claimGrokBotMachine writes version-1 binding so authorize short-circuits', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oz-claim-'));
  try {
    const r = claimGrokBotMachine('https://127.0.0.1:8443', { home: tmp, platform: 'linux' });
    assert.equal(r.written.length, 4);
    const p = path.join(tmp, '.config', 'Grok Bot', '.env-descriptor-account-bindings.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(j.version, 1);
    assert.equal(j.bindings[r.descriptorKey], r.accountKey);
    assert.equal(r.descriptorKey, sandDescriptorKey('https://127.0.0.1:8443'));
    assert.equal(r.accountKey, sandAccountKey('openzoo-user'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('packed sidecar overlay includes cursorbackend auth fake', () => {
  const after = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokui-app/build/afterPack.js'), 'utf8');
  assert.match(after, /lib\/cursorbackend\.js/);
  assert.match(after, /lib\/cursorapi\.js/);
  assert.match(after, /lib\/grokbotAccount\.js/);
  assert.match(after, /fs\.cpSync\(libSrc, libDest/);
  const be = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/cursorbackend.js'), 'utf8');
  assert.match(be, /FAKE \$\{fakeAuth\.kind\} logged-in/);
  const acct = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/grokbotAccount.js'), 'utf8');
  assert.match(acct, /export function grokroomAgentId/);
  const cli = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/grokcli.js'), 'utf8');
  assert.match(cli, /claimGrokBotMachine/);
  assert.match(cli, /machine-claim openzoo-user/);
});
