import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { oursOn, packageVersion } from '../lib/proxy.js';

test('installed version alone cannot disguise a stale running proxy', async () => {
  let payload = { version: packageVersion() };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await oursOn(port), false);
    payload.runtimeVersion = packageVersion();
    assert.equal(await oursOn(port), true);
    payload.runtimeVersion = '0.1.0';
    assert.equal(await oursOn(port), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
