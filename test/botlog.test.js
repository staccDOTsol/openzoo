import assert from 'node:assert/strict';
import test from 'node:test';
import { isBotMilestone, makeBotLogger, payBannerLines } from '../lib/botlog.js';

test('quiet mode drops wire noise and keeps milestones and problems', () => {
  const noise = [
    'cursor-backend: #12 POST /aiserver.v1.DashboardService/GetUserPrivacyMode  ct=application/proto  body=0b',
    'cursor-tls: connected alpn=http/1.1 sni=?',
    'cursor-backend:      -> empty-ok',
    'cursor-backend:      -> pod /health ok',
    'cursor-backend:      -> transcript 4e5e8b1e n=13/13',
    'cursor-backend:      POST /oauth/token -> REAL api2.cursor.sh (200, 880b)',
    'cursor-backend:      listAgents local n=1 account=4297 active=4e5e',
    'cursor-backend:      mcp chrome-devtools chrome-devtools-mcp exposes content of the browser instance',
    'cursor-backend:      mcp chrome-devtools Performance tools may send trace URLs',
  ];
  for (const l of noise) assert.equal(isBotMilestone(l), false, l);
  const keep = [
    'cursor-backend:      mcp ready servers=chrome-devtools tools=29',
    'cursor-backend:      mcp chrome-devtools mode=own-profile ~/.cache/chrome-devtools-mcp/chrome-profile',
    'cursor-backend:      mcp chrome-devtools To let bots drive your real Chrome (your logins): open chrome://inspect',
    'cursor-backend:      mcp dff FAIL fetch failed',
    'cursor-backend:      x402 402 — dwell/retry 1/4',
    'upstream outage: model=auto openzoo gateway upstream is out of credits',
    'cursor-backend:      wakeups restored 13',
    'cursor-backend:      sendPrompt done agent=abc seq=9 text="…"',
    'cursor-backend:      mcp brave-devtools attached tools=29',
  ];
  for (const l of keep) assert.equal(isBotMilestone(l), true, l);
});

test('makeBotLogger: verbose prints everything, quiet prints milestones only', () => {
  const out = [];
  const quiet = makeBotLogger({ verbose: false, write: (m) => out.push(m) });
  quiet('cursor-tls: connected alpn=none sni=?');
  quiet('cursor-backend:      mcp ready servers=x tools=1');
  assert.deepEqual(out, ['  backend: cursor-backend:      mcp ready servers=x tools=1']);
  const all = [];
  const loud = makeBotLogger({ verbose: true, write: (m) => all.push(m) });
  loud('cursor-tls: connected alpn=none sni=?');
  assert.equal(all.length, 1);
});

test('pay banner says where to send money, the card link, the chrome toggle, and what to type first', () => {
  const lines = payBannerLines({ solana: 'HLyP…kku', evm: '0x6409…9AA1', balances: { USDC: 0.000188, BASE_USDC: 0.04 }, chromeMode: 'own-profile' });
  const text = lines.join('\n');
  assert.match(text, /HOW TO PAY/);
  assert.match(text, /Solana +HLyP…kku/);
  assert.match(text, /USDC +EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/);
  assert.match(text, /TOKEN +EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump +\(half price\)/);
  assert.match(text, /LEOS +5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e +\(half price\)/);
  assert.match(text, /USDC +0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/);
  assert.match(text, /Base +0x6409…9AA1/);
  assert.match(text, /whop\.com\/staccoverflow\/openzoo/);
  assert.match(text, /chrome:\/\/inspect\/#remote-debugging/);
  assert.match(text, /set up Grok Ship for/);
  assert.match(text, /--verbose/);
  const attached = payBannerLines({ solana: 'a', evm: 'b', chromeMode: 'real-chrome' }).join('\n');
  assert.match(attached, /attached to your real browser \(real-chrome\)/);
  assert.doesNotMatch(attached, /flip chrome:/);
});
