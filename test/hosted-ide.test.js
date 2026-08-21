import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDE_PUBLIC_ORIGIN, IDE_SESSION_PATH, ideOrigin, ideSessionEndpoint,
  ideFrameSrc, publicIdeSession, createIdeSession, openStoredIdeSession,
} from '../lib/hosted-ide.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('public door is zoo.openzoo.fun/ide/session, not fly.dev', () => {
  assert.equal(IDE_PUBLIC_ORIGIN, 'https://zoo.openzoo.fun');
  assert.equal(IDE_SESSION_PATH, '/ide/session');
  assert.equal(ideSessionEndpoint(), 'https://zoo.openzoo.fun/ide/session');
  assert.doesNotMatch(ideSessionEndpoint(), /fly\.dev/);
  assert.doesNotMatch(ideSessionEndpoint(), /x402-tokens/);
  assert.equal(ideOrigin({ OPENZOO_IDE_ORIGIN: 'https://ide.test' }), 'https://ide.test');
});

test('ideFrameSrc applies password as query or basic; never invents a host', () => {
  assert.equal(ideFrameSrc(''), '');
  assert.equal(ideFrameSrc('not a url'), '');
  assert.equal(ideFrameSrc('javascript:alert(1)'), '');
  assert.equal(ideFrameSrc('https://box.example/ide'), 'https://box.example/ide');
  assert.equal(
    ideFrameSrc('https://box.example/ide?folder=/workspace', 's3cret'),
    'https://box.example/ide?folder=%2Fworkspace&password=s3cret',
  );
  assert.equal(
    ideFrameSrc('https://box.example/ide', 's3cret', { auth: 'basic' }),
    'https://coder:s3cret@box.example/ide',
  );
  assert.equal(
    ideFrameSrc('https://box.example/ide?password=already', 'other'),
    'https://box.example/ide?password=already',
  );
});

test('publicIdeSession never includes the subscription key or a password field', () => {
  const pub = publicIdeSession({
    ok: true, url: 'https://box.example/ide?password=s3cret', id: 'sess-1',
  });
  assert.equal(pub.ok, true);
  assert.equal(pub.id, 'sess-1');
  assert.equal(JSON.stringify(pub).includes('password":'), false);
  assert.equal(publicIdeSession({ ok: false, status: 401 }).status, 401);
});

test('createIdeSession: no key is 401 and does not hit the network', async () => {
  let calls = 0;
  const miss = await createIdeSession({
    key: '',
    fetchImpl: async () => { calls += 1; throw new Error('network'); },
  });
  assert.equal(miss.status, 401);
  assert.equal(miss.ok, false);
  assert.equal(calls, 0);
  const short = await createIdeSession({ key: 'abc', fetchImpl: async () => { calls += 1; return {}; } });
  assert.equal(short.status, 401);
  assert.equal(calls, 0);
});

test('createIdeSession POSTs Bearer subscription key; never ANTHROPIC_API_KEY', async () => {
  const door = await listen(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/ide/session');
    assert.equal(req.headers.authorization, 'Bearer oz_live_good_key_xxxxxx');
    assert.equal(req.headers['anthropic-api-key'], undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      url: 'https://box.example/ide',
      password: 'boxpass',
      id: 'ide-1',
    }));
  });
  try {
    const out = await createIdeSession({
      key: 'oz_live_good_key_xxxxxx',
      origin: door.origin,
    });
    assert.equal(out.ok, true);
    assert.equal(out.id, 'ide-1');
    assert.equal(out.url, 'https://box.example/ide?password=boxpass');
    const pub = publicIdeSession(out);
    assert.equal(JSON.stringify(pub).includes('oz_live'), false);
    assert.equal(JSON.stringify(pub).includes('boxpass'), true); // baked into url for the iframe
    assert.equal(Object.prototype.hasOwnProperty.call(pub, 'password'), false);
  } finally {
    await door.close();
  }
});

test('createIdeSession: door 401 → 401; empty url is not an open session', async () => {
  const unauthorized = await createIdeSession({
    key: 'oz_live_bad_key_xxxxxx',
    fetchImpl: async () => ({ status: 401, json: async () => ({ error: 'unauthorized' }) }),
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.status, 401);

  const empty = await createIdeSession({
    key: 'oz_live_good_key_xxxxxx',
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true }) }),
  });
  assert.equal(empty.ok, false);
  assert.ok(empty.status >= 400);

  const down = await createIdeSession({
    key: 'oz_live_good_key_xxxxxx',
    fetchImpl: async () => { throw new Error('econnrefused'); },
  });
  assert.equal(down.status, 503);
});

test('openStoredIdeSession uses the stored subscription key, not ANTHROPIC_API_KEY', async () => {
  let seen;
  const out = await openStoredIdeSession({
    sub: { key: 'oz_from_file_keyxx' },
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { status: 200, json: async () => ({ url: 'https://ide.example/', id: 'a' }) };
    },
  });
  assert.equal(out.ok, true);
  assert.match(seen.url, /\/ide\/session$/);
  assert.equal(seen.init.headers.authorization, 'Bearer oz_from_file_keyxx');
  assert.equal(seen.init.headers.ANTHROPIC_API_KEY, undefined);
  assert.equal(JSON.stringify(seen.init.headers).includes('ANTHROPIC'), false);
});

test('hosted-ide.js never mentions ANTHROPIC_API_KEY as a header value', () => {
  const src = readFileSync(path.join(root, 'lib', 'hosted-ide.js'), 'utf8');
  assert.match(src, /Never ANTHROPIC_API_KEY/);
  assert.match(src, /Bearer/);
  assert.match(src, /zoo\.openzoo\.fun/);
  assert.match(src, /\/ide\/session/);
  assert.doesNotMatch(src, /ANTHROPIC_API_KEY:/);
  assert.doesNotMatch(src, /headers\.ANTHROPIC/);
  assert.doesNotMatch(src, /console\.(log|info|debug|error).*key/);
});
