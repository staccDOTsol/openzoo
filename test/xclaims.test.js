import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimTweet, markDone, releaseTweet, listClaims, tweetIdFrom, loadClaims } from '../lib/xclaims.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oz-xclaims-'));

test('tweetIdFrom accepts status URLs and bare ids', () => {
  assert.equal(tweetIdFrom('https://x.com/someone/status/2094904151931056339?s=20'), '2094904151931056339');
  assert.equal(tweetIdFrom('2094904151931056339'), '2094904151931056339');
  assert.equal(tweetIdFrom('https://x.com/grok/with_replies'), '');
});

test('two bots cannot hold the same tweet; the lease expires; done is permanent', () => {
  const home = tmpHome();
  const t = 'https://x.com/a/status/1234567890123';
  const a = claimTweet({ tweet: t, by: 'A', name: 'bot A', home, now: 1000, ttlMs: 500 });
  assert.equal(a.ok, true);
  const b = claimTweet({ tweet: t, by: 'B', name: 'bot B', home, now: 1200, ttlMs: 500 });
  assert.equal(b.ok, false);
  assert.equal(b.by, 'bot A');
  // same bot re-claims fine
  assert.equal(claimTweet({ tweet: t, by: 'A', home, now: 1300, ttlMs: 500 }).ok, true);
  // lease expired -> B gets it
  const b2 = claimTweet({ tweet: t, by: 'B', name: 'bot B', home, now: 2000, ttlMs: 500 });
  assert.equal(b2.ok, true);
  // B posts -> permanent
  const ledger = path.join(home, 'ledger.json');
  const d = markDone({ tweet: t, by: 'B', name: 'bot B', url: 'https://x.com/openzoobot/status/999', lane: '4', home, ledgerPath: ledger, now: 2100 });
  assert.equal(d.ok, true);
  assert.equal(claimTweet({ tweet: t, by: 'A', home, now: 99999 }).ok, false);
  assert.equal(claimTweet({ tweet: t, by: 'A', home, now: 99999 }).reason, 'already replied');
  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(led.posted.length, 1);
  assert.equal(led.posted[0].ours, 'https://x.com/openzoobot/status/999');
  assert.equal(led.posted[0].lane, '4');
  const l = listClaims({ home, now: 2200 });
  assert.deepEqual(l.done, ['1234567890123']);
  assert.equal(l.live.length, 0);
});

test('release gives a claim back only to its holder; garbage file is tolerated', () => {
  const home = tmpHome();
  claimTweet({ tweet: '555555555555', by: 'A', home, now: 1 });
  assert.equal(releaseTweet({ tweet: '555555555555', by: 'B', home }).ok, false);
  assert.equal(releaseTweet({ tweet: '555555555555', by: 'A', home }).released, true);
  assert.equal(claimTweet({ tweet: '555555555555', by: 'B', home, now: 2 }).ok, true);
  fs.writeFileSync(path.join(home, '.openzoo', 'xclaims.json'), '[]');
  assert.deepEqual(loadClaims(home), {});
});
