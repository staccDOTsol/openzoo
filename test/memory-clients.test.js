import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openzoo-memory-clients-'));
const wallet = Keypair.generate();
process.env.OPENZOO_WALLET = path.join(dir, 'wallet.json');
process.env.OPENZOO_VOICE_STATE = path.join(dir, 'voice.json');
process.env.OPENZOO_SONAR_DIR = path.join(dir, 'sonar');
process.env.OPENZOO_API_BASE = 'https://gateway.test';
process.env.OPENZOO_GATEWAY = 'https://gateway.test';
fs.writeFileSync(process.env.OPENZOO_WALLET, JSON.stringify({ solana: [...wallet.secretKey], evm: '0x' + '12'.repeat(32) }), { mode: 0o600 });
const originalFetch = globalThis.fetch;
const seen = [];
const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.publicKey.toBuffer()]), type: 'spki', format: 'der' });
function checkSignature(headers) {
  assert.equal(headers['x-openzoo-namespace-signer'], wallet.publicKey.toBase58());
  let n = 0n;
  for (const c of headers['x-openzoo-namespace-sig']) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));
  assert.ok(crypto.verify(null, Buffer.from(`openzoo-namespace:${headers['x-openzoo-namespace']}:${headers['x-openzoo-namespace-ts']}`), pub, Buffer.from(n.toString(16).padStart(128, '0'), 'hex')));
}

test('bot, voice and sonar save and recall only through the signed private gateway', async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(String(url).startsWith('https://gateway.test/v1/'));
    assert.ok(!String(url).includes('/internal/'));
    const body = JSON.parse(init.body || '{}');
    if (String(url).includes('/hrr/')) {
      checkSignature(init.headers);
      assert.equal(body.tenant_id, undefined);
      seen.push({ url, body });
    }
    const data = String(url).endsWith('/models') ? { data: [] }
      : String(url).endsWith('/chat/completions') ? { accepts: [] }
      : String(url).endsWith('/recall') ? { items: [{ text: 'instructions: bind, recall', score: 1 }] }
      : { context_id: 'ctx_TEST', bound: 1 };
    return new Response(JSON.stringify(data), { status: String(url).endsWith('/chat/completions') ? 402 : 200 });
  };
  try {
    const bot = await import('../lib/xbot.js');
    assert.equal(await bot.ensureSharedContext(null), 'ctx_TEST');
    assert.equal(await bot.bindThread('ctx_TEST', [{ text: 'Signed memory test thread' }]), 1);
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'tweets.js'), 'window.YTD.tweets.part0 = ' + JSON.stringify([{ tweet: { full_text: 'Signed voice test passage for a private context.' } }]));
    const voice = await import('../lib/voice.js');
    const state = await voice.ingestVoice({ twitterDir: dir });
    assert.equal(state.tiers.cream.daemonCtx, 'ctx_TEST');
    assert.ok((await voice.recallExemplars('test', { state })).exemplars.length);
    fs.mkdirSync(process.env.OPENZOO_SONAR_DIR);
    fs.writeFileSync(path.join(process.env.OPENZOO_SONAR_DIR, 'idls.jsonl'), JSON.stringify({ programId: 'test', idl: { instructions: [{ name: 'bind' }] } }) + '\n');
    const sonar = await import('../lib/sonar.js');
    assert.equal((await sonar.bindCorpus()).contextId, 'ctx_TEST');
    assert.deepEqual(await sonar.recallVocabulary('test'), ['bind', 'recall']);
    assert.equal(seen.filter(x => x.url.endsWith('/bind')).length, 7);
    assert.equal(seen.filter(x => x.url.endsWith('/recall')).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
