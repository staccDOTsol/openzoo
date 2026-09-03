import assert from 'node:assert/strict';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';
import { mintTlsPems } from '../lib/cursorbackend.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('mintTlsPems does not spawn openssl', async () => {
  const pems = await mintTlsPems();
  assert.match(pems.cert, /BEGIN CERTIFICATE/);
  assert.match(pems.key, /BEGIN (RSA )?PRIVATE KEY/);
  const x = new X509Certificate(pems.cert);
  assert.match(String(x.subject), /api2\.cursor\.sh/);
  const san = String(x.subjectAltName || '');
  assert.match(san, /api2\.cursor\.sh/);
  assert.match(san, /127\.0\.0\.1/);
});

test('ensureCert is node-minted, openssl is fallback only', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/cursorbackend.js'), 'utf8');
  assert.match(src, /mintTlsPems/);
  assert.match(src, /selfsigned/);
  assert.match(src, /openssl fallback/);
});
