import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCursorJwt, fakeCursorTokens, fakeCursorAuthReply } from '../lib/cursorapi.js';
import { grokBotLaunchEnv } from '../lib/grokcli.js';

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
});
