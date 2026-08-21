import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  startHostedOcc, fingerprintKey, occZooEnv, occSpawnSpec,
  writeOccPtyLine, ptyLooksReady, safeResolveIn, sanitizeUploadName,
  parseMultipart, OCC_PUBLIC_ORIGIN, stripPtyLineTail,
} from '../lib/hosted-occ.js';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'oz-occ-'));
}

function fakeVerify(okKeys) {
  const set = new Set(okKeys);
  return async (key) => {
    if (set.has(key)) return { ok: true, tier: 'pro', tierName: 'Pro' };
    return { ok: false, status: 401, error: 'unauthorized' };
  };
}

function fakePty() {
  const writes = [];
  const dataFns = [];
  const exitFns = [];
  let lastSpec = null;
  const spawn = (spec, { cwd } = {}) => {
    lastSpec = { spec, cwd };
    return {
      write: (s) => writes.push(s),
      resize: () => {},
      onData: (fn) => dataFns.push(fn),
      onExit: (fn) => exitFns.push(fn),
      kill: () => {},
    };
  };
  return {
    writes,
    dataFns,
    lastSpec,
    spawn,
    getLast() { return lastSpec; },
    push(s) { for (const fn of dataFns) fn(Buffer.from(s)); },
  };
}

async function listen(api, env = {}) {
  return startHostedOcc({
    ...api,
    env: { ...process.env, OPENZOO_OCC_BIND: '127.0.0.1', OPENZOO_OCC_PORT: '0', ...env },
    bind: '127.0.0.1',
    port: 0,
  });
}

async function closeServer(started) {
  await new Promise((resolve) => started.server.close(resolve));
  started.close();
}

test('public door is zoo.openzoo.fun, not fly.dev or marketing /occ HTML', () => {
  assert.equal(OCC_PUBLIC_ORIGIN, 'https://zoo.openzoo.fun');
  assert.doesNotMatch(OCC_PUBLIC_ORIGIN, /fly\.dev/);
  assert.doesNotMatch(OCC_PUBLIC_ORIGIN, /^https:\/\/openzoo\.fun$/);
});

test('occ spawn env is the validated sub key; ANTHROPIC_API_KEY unset', () => {
  const env = occZooEnv({
    HOME: tmp(),
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENZOO_CLAUDE_PATH_ONLY: '1',
  }, { token: 'oz_user_sub_key', base: 'https://x402-tokens.fly.dev/v1' });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'oz_user_sub_key');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://x402-tokens.fly.dev/v1');
});

test('safeResolveIn blocks traversal; sanitizeUploadName is a basename', () => {
  const dir = tmp();
  assert.equal(safeResolveIn(dir, 'notes.txt'), path.join(dir, 'notes.txt'));
  assert.throws(() => safeResolveIn(dir, '../etc/passwd'));
  assert.throws(() => safeResolveIn(dir, '/etc/passwd'));
  assert.throws(() => safeResolveIn(dir, '..\\secret'));
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeUploadName(''), 'file');
});

test('writeOccPtyLine: /goal at prompt is line+CR; busy slash Esc-then-line', async () => {
  const writes = [];
  const ready = { write: (s) => writes.push(s), buf: Buffer.from('> '), dead: false };
  assert.equal(ptyLooksReady(ready), true);
  await writeOccPtyLine(ready, '/goal ship it');
  assert.deepEqual(writes, ['/goal ship it' + CR]);
  assert.equal(ready.goalSet, true);

  writes.length = 0;
  const busy = { write: (s) => writes.push(s), buf: Buffer.from('running'), dead: false, didWriteLine: true };
  const p = writeOccPtyLine(busy, '/goal later');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(writes[0], ESC);
  busy.buf = Buffer.concat([busy.buf, Buffer.from('\n> ')]);
  await p;
  assert.equal(writes[1], '/goal later' + CR);
  assert.equal(stripPtyLineTail('/goal x\r\n'), '/goal x');
});

test('hosted OCC: 401 without Bearer; no session; query token refused', async () => {
  const home = tmp();
  const pty = fakePty();
  let verifyCalls = 0;
  const started = await listen({
    root: home,
    verify: async () => { verifyCalls += 1; return { ok: false, status: 401, error: 'unauthorized' }; },
    spawn: pty.spawn,
    log: () => {},
  });
  try {
    const base = started.url;
    const miss = await fetch(base + '/occ/sessions', { method: 'POST', body: '{}' });
    assert.equal(miss.status, 401);
    const q = await fetch(base + '/occ/sessions?token=oz_leaked', { method: 'POST', body: '{}' });
    assert.equal(q.status, 401);
    const fake = await fetch(base + '/occ/sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer oz_bad_key_xxxxxx', 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't1', name: 'n' }),
    });
    assert.equal(fake.status, 401);
    assert.equal(started.sessions.size, 0);
    assert.equal(pty.writes.length, 0);
    assert.ok(verifyCalls >= 1);
  } finally {
    await closeServer(started);
  }
});

test('iOS door: create session, /goal message SSE, upload, stop, isolation', async () => {
  const home = tmp();
  const pty = fakePty();
  const started = await listen({
    root: home,
    verify: fakeVerify(['oz_alice_key_xxxxxx', 'oz_bob_key_xxxxxx']),
    spawn: pty.spawn,
    log: () => {},
    completionsUrl: 'https://x402-tokens.fly.dev/v1',
  });
  const alice = { authorization: 'Bearer oz_alice_key_xxxxxx', 'content-type': 'application/json' };
  const bob = { authorization: 'Bearer oz_bob_key_xxxxxx', 'content-type': 'application/json' };
  try {
    const created = await fetch(started.url + '/occ/sessions', {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ threadId: 'ios-thread-1', name: 'New chat' }),
    });
    assert.equal(created.status, 200);
    const sess = await created.json();
    assert.ok(sess.id);
    assert.equal(sess.session_id, sess.id);
    const sid = sess.id;

    const resume = await fetch(started.url + '/occ/sessions', {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ threadId: 'ios-thread-1', name: 'New chat' }),
    });
    assert.equal((await resume.json()).id, sid);

    const spec = pty.getLast()?.spec;
    assert.ok(spec);
    assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'oz_alice_key_xxxxxx');
    assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(spec.env.ANTHROPIC_BASE_URL, 'https://x402-tokens.fly.dev/v1');
    assert.ok(!JSON.stringify(spec.env).includes('sk-ant-'));

    const aliceFp = fingerprintKey('oz_alice_key_xxxxxx');
    assert.ok(pty.getLast().cwd.includes(aliceFp.slice(0, 32)));
    assert.ok(pty.getLast().cwd.includes(sid));

    started.sessions.get(sid).buf = Buffer.from('> ');
    const ac = new AbortController();
    const msgP = fetch(started.url + '/occ/sessions/' + sid + '/messages', {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ text: '/goal list the repo', message: '/goal list the repo', stream: true }),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(pty.writes.some((w) => String(w).startsWith('/goal list the repo')));
    pty.push('working on it\n');
    pty.push('> ');
    const msg = await msgP;
    assert.equal(msg.status, 200);
    assert.match(msg.headers.get('content-type') || '', /text\/event-stream/);
    const sse = await msg.text();
    assert.match(sse, /"type":"delta"/);
    assert.match(sse, /working on it/);
    assert.match(sse, /"type":"done"/);
    assert.doesNotMatch(sse, /oz_alice_key/);

    const up = await fetch(started.url + '/occ/sessions/' + sid + '/files', {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ name: 'notes.txt', content: 'hello zoo', encoding: 'utf8' }),
    });
    assert.equal(up.status, 200);
    const saved = await up.json();
    assert.equal(saved.path, 'notes.txt');
    assert.equal(readFileSync(path.join(pty.getLast().cwd, 'notes.txt'), 'utf8'), 'hello zoo');

    const traverse = await fetch(started.url + '/occ/sessions/' + sid + '/files', {
      method: 'POST',
      headers: alice,
      body: JSON.stringify({ name: '../../etc/passwd', content: 'x', encoding: 'utf8' }),
    });
    assert.equal(traverse.status, 200);
    assert.equal((await traverse.json()).path, 'passwd');
    assert.ok(!readFileSync(path.join(pty.getLast().cwd, 'passwd'), 'utf8').includes || true);
    assert.equal(readFileSync(path.join(pty.getLast().cwd, 'passwd'), 'utf8'), 'x');

    const listed = await (await fetch(started.url + '/occ/sessions/' + sid + '/files', { headers: alice })).json();
    assert.ok(listed.files.some((f) => f.path === 'notes.txt'));

    const steal = await fetch(started.url + '/occ/sessions/' + sid + '/messages', {
      method: 'POST',
      headers: bob,
      body: JSON.stringify({ text: 'hi', message: 'hi', stream: true }),
    });
    assert.equal(steal.status, 404);
    const stealUp = await fetch(started.url + '/occ/sessions/' + sid + '/files', {
      method: 'POST',
      headers: bob,
      body: JSON.stringify({ name: 'evil.txt', content: 'nope', encoding: 'utf8' }),
    });
    assert.equal(stealUp.status, 404);

    const stop = await fetch(started.url + '/occ/sessions/' + sid + '/stop', {
      method: 'POST',
      headers: alice,
      body: '{}',
    });
    assert.equal(stop.status, 200);
    assert.ok(pty.writes.includes(ESC));
  } finally {
    await closeServer(started);
    rmSync(home, { recursive: true, force: true });
  }
});

test('multipart file field lands in the session cwd', async () => {
  const home = tmp();
  const pty = fakePty();
  const started = await listen({
    root: home,
    verify: fakeVerify(['oz_alice_key_xxxxxx']),
    spawn: pty.spawn,
    log: () => {},
  });
  const alice = { authorization: 'Bearer oz_alice_key_xxxxxx' };
  try {
    const sess = await (await fetch(started.url + '/occ/sessions', {
      method: 'POST',
      headers: { ...alice, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't', name: 'n' }),
    })).json();
    const boundary = '----OzOccBound7';
    const body = Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="file"; filename="shot.png"\r\n'
      + 'Content-Type: image/png\r\n\r\n'
      + 'PNGDATA\r\n'
      + `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="name"\r\n\r\n'
      + 'shot.png\r\n'
      + `--${boundary}--\r\n`,
    );
    const up = await fetch(started.url + '/occ/sessions/' + sess.id + '/files', {
      method: 'POST',
      headers: { ...alice, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    assert.equal(up.status, 200);
    const info = await up.json();
    assert.equal(info.name, 'shot.png');
    assert.equal(readFileSync(path.join(pty.getLast().cwd, 'shot.png'), 'utf8'), 'PNGDATA');
  } finally {
    await closeServer(started);
    rmSync(home, { recursive: true, force: true });
  }
});

test('upload size cap; logs never include the raw token', async () => {
  const home = tmp();
  const pty = fakePty();
  const lines = [];
  const started = await listen({
    root: home,
    verify: fakeVerify(['oz_alice_key_xxxxxx']),
    spawn: pty.spawn,
    uploadMax: 32,
    log: (s) => lines.push(String(s)),
  });
  const secret = 'oz_alice_key_xxxxxx';
  try {
    const miss = await fetch(started.url + '/occ/sessions', { method: 'POST', body: '{}' });
    assert.equal(miss.status, 401);
    const created = await fetch(started.url + '/occ/sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 't' }),
    });
    const sid = (await created.json()).id;
    const big = await fetch(started.url + '/occ/sessions/' + sid + '/files', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'big.bin', content: 'x'.repeat(80), encoding: 'utf8' }),
    });
    assert.equal(big.status, 413);
    assert.equal(lines.join('\n').includes(secret), false);
  } finally {
    await closeServer(started);
    rmSync(home, { recursive: true, force: true });
  }
});

test('parseMultipart extracts file + name fields', () => {
  const boundary = 'xyz';
  const buf = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nHI\r\n--${boundary}--\r\n`,
  );
  const parts = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parts.files[0].name, 'a.txt');
  assert.equal(parts.files[0].data.toString(), 'HI');
});

test('occSpawnSpec packed tree unsets ANTHROPIC_API_KEY', () => {
  const dir = tmp();
  const resources = path.join(dir, 'resources');
  const claude = path.join(resources, 'openzoo-claude');
  mkdirSync(path.join(claude, 'v2', 'src'), { recursive: true });
  writeFileSync(path.join(claude, 'package.json'), JSON.stringify({
    name: 'openzoo-claude', bin: { 'openzoo-claude': 'v2/src/index.mjs' },
  }));
  writeFileSync(path.join(claude, 'v2', 'src', 'index.mjs'), 'export {}\n');
  const spec = occSpawnSpec({
    env: {
      HOME: path.join(dir, 'home'),
      OZ_PACKED_RESOURCES: resources,
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-nope',
    },
    execPath: path.join(dir, 'openzoo'),
    token: 'oz_live_from_phone',
    base: 'https://x402-tokens.fly.dev/v1',
  });
  assert.ok(spec);
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'oz_live_from_phone');
  assert.ok(!spec.args.includes('--append-system-prompt'));
});
