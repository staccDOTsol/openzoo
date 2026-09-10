import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import { withNamespace } from '../lib/namespace.js';

test('every namespace header is signed by the supplied wallet', () => {
  const keypair = Keypair.generate();
  const headers = withNamespace({}, { keypair });
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of headers['x-openzoo-namespace-sig']) n = n * 58n + BigInt(alphabet.indexOf(c));
  const hex = n.toString(16).padStart(128, '0');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keypair.publicKey.toBuffer()]), type: 'spki', format: 'der' });
  assert.equal(headers['x-openzoo-namespace-signer'], keypair.publicKey.toBase58());
  assert.ok(crypto.verify(null, Buffer.from(`openzoo-namespace:${headers['x-openzoo-namespace']}:${headers['x-openzoo-namespace-ts']}`), publicKey, Buffer.from(hex, 'hex')));
});

test('an invalid wallet throws instead of returning unsigned headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openzoo-signature-test-'));
  try {
    const file = path.join(dir, 'wallet.json');
    fs.writeFileSync(file, '{"solana":[]}');
    const moduleUrl = new URL('../lib/namespace.js', import.meta.url).href;
    const code = `import {withNamespace} from ${JSON.stringify(moduleUrl)}; try {withNamespace();process.exit(2)}catch{process.exit(0)}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, OPENZOO_WALLET: file }, encoding: 'utf8' });
    assert.equal(result.status, 0, 'wallet failure must stop the operation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stale session and mixed-case identity headers cannot override the active signer', () => {
  const keypair = Keypair.generate();
  for (const input of [new Headers({ 'X-Openzoo-Session': 'stale', 'X-Openzoo-Namespace-Signer': 'foreign', 'Content-Type': 'application/json' }), [['X-Openzoo-Session', 'stale'], ['Content-Type', 'application/json']]]) {
    const headers = withNamespace(input, { keypair });
    assert.equal(headers['x-openzoo-session'], undefined);
    assert.equal(headers['x-openzoo-namespace-signer'], keypair.publicKey.toBase58());
    assert.equal(headers['content-type'], 'application/json');
  }
  assert.throws(() => withNamespace({}, {}), /cannot sign/);
});
