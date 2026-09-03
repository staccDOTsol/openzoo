import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  accountSlug, accountDir, accountAgentsPath, houseAgentsPath, rosterForAccount, rosterForEvent,
  callerKeyFromAuth, readHouseRoster, mergeAgentRecords, shapeAgent, agentBrief, briefFromName,
  looksLikeAgentId, nameFromBrief, displayName, preferNamedAgent,
  grokroomAgentId, grokroomMemberId, grokroomShareUrl, agentShareUrl, groupShareState,
  mintOnchainRoom, ensureOnchainRoom, attachOnchainRoom,
  isGrokRoomAgent, isGrokRoomMember,
  parseWakeupEvery, wantsWakeupCron, shapeWakeup, readWakeups, writeWakeups, wakeupsPath,
  WAKEUP_MIN_SEC, WAKEUP_DEFAULT_SEC,
  addDeletedIds, filterDeleted, readDeletedIds,
} from '../lib/grokbotAccount.js';

test('accountSlug strips junk and rejects empty', () => {
  assert.equal(accountSlug('4297a5d2cd1c26365eb9'), '4297a5d2cd1c26365eb9');
  assert.equal(accountSlug('../etc/passwd'), 'etcpasswd');
  assert.equal(accountSlug('..'), null);
  assert.equal(accountSlug(''), null);
});

test('account paths are under ~/.openzoo/grokbot/<id>/', () => {
  const home = os.homedir();
  const dir = accountDir(home, '4297a5d2cd1c26365eb9');
  assert.match(dir, /\/\.openzoo\/grokbot\/4297a5d2cd1c26365eb9$/);
  assert.equal(accountAgentsPath(home, '4297a5d2cd1c26365eb9'), `${dir}/agents.json`);
  assert.equal(accountDir(home, ''), null);
});

test('cached tray is never served to a different Cursor account', () => {
  const cached = [{ id: 'stacc-chat', name: 'hi' }];
  assert.deepEqual(rosterForAccount({
    liveAccountId: 'bbb', cachedAccountId: 'aaa', cached,
  }), []);
  assert.deepEqual(rosterForAccount({
    liveAccountId: 'aaa', cachedAccountId: 'aaa', cached,
  }), cached);
});

test('cafe visitors with no Cursor account get the house fallback', () => {
  const cached = [{ id: 'stacc-chat', name: 'hi' }];
  const fallback = [{ id: 'house', name: 'cafe' }];
  assert.deepEqual(rosterForAccount({
    liveAccountId: '', cachedAccountId: 'aaa', cached, fallback,
  }), fallback);
  assert.deepEqual(rosterForAccount({
    liveAccountId: '', cachedAccountId: '', cached,
  }), cached);
  assert.deepEqual(rosterForAccount({
    liveAccountId: 'aaa', cachedAccountId: '', cached, fallback,
  }), fallback);
});

test('readHouseRoster is shared, not gated on a live Cursor account', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-house-'));
  try {
    fs.mkdirSync(path.join(tmp, '.openzoo', 'grokbot', 'acctA'), { recursive: true });
    fs.writeFileSync(houseAgentsPath(tmp), JSON.stringify([{ id: 'g', name: 'global' }]));
    fs.writeFileSync(accountAgentsPath(tmp, 'acctA'), JSON.stringify([{ id: 'a', name: 'acct' }, { id: 'g', name: 'acct-global' }]));
    const noAccount = readHouseRoster(tmp, null);
    assert.equal(noAccount.length, 2);
    assert.deepEqual(noAccount.map((x) => x.id).sort(), ['a', 'g']);
    const withAccount = readHouseRoster(tmp, 'acctA');
    assert.equal(withAccount[0].id, 'a');
    assert.equal(withAccount.find((x) => x.id === 'g').name, 'acct-global');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shapeAgent fills the fields client persistence requires or it wipes the tray', () => {
  const a = shapeAgent({ id: 'g1', name: 'room', memberAgentIds: ['a', 'b'] });
  assert.equal(a.isGroup, true);
  assert.deepEqual(a.memberIds, ['a', 'b']);
  assert.equal(typeof a.hasUnread, 'boolean');
  assert.equal(typeof a.notificationsEnabled, 'boolean');
  assert.equal(typeof a.notifyOnUpdatesEnabled, 'boolean');
  assert.equal(a.lastMessageId, null);
  assert.equal(a.lastEntry, null);
  assert.equal(a.awaitingUserResponse, null);
  assert.equal(typeof a.description, 'string');
  assert.equal(typeof a.path, 'string');
  assert.equal(typeof a.origin, 'string');
  const solo = shapeAgent({ id: 'c1', name: 'hi' });
  assert.equal(solo.isGroup, false);
  assert.deepEqual(solo.memberIds, []);
});

test('shapeAgent keeps brief so a restart is not amnesia', () => {
  const a = shapeAgent({ id: 'm1', name: 'Marketing', brief: 'post on x.com/staccoverflow' });
  assert.equal(a.brief, 'post on x.com/staccoverflow');
  assert.equal(agentBrief(a), 'post on x.com/staccoverflow');
  const b = shapeAgent({ id: 'm2', name: 'DevOps', instructions: 'ship fly.toml' });
  assert.equal(b.brief, 'ship fly.toml');
});

test('briefFromName fills a job when spawn omitted brief', () => {
  const n = briefFromName('6 · Content Studio');
  assert.match(n, /Content Studio/);
  assert.match(n, /Do not ask the human to re-brief/);
  const shaped = shapeAgent({ id: 'c6', name: '6 · Content Studio' });
  assert.match(shaped.brief, /Content Studio/);
  assert.equal(briefFromName('New Bot'), '');
  assert.equal(briefFromName('chat'), '');
  assert.equal(briefFromName('4a86cfa1-b902-40b4-9cfd-06a1c0adaff7'), '');
});

test('shapeAgent does not persist a UUID as the sidebar name', () => {
  const id = '088c4bea-65d1-4b78-9c71-da6b76ef6482';
  const fromJob = shapeAgent({
    id,
    name: id,
    title: id,
    brief: `You are ${id}. Job: Product Simplification. Flagship is OpenZoo.`,
  });
  assert.equal(fromJob.name, 'Product Simplification');
  assert.match(fromJob.brief, /Product Simplification/);
  assert.doesNotMatch(fromJob.brief, new RegExp(`You are ${id}`));
  assert.equal(nameFromBrief(`You are 6 · Content Studio for Stacc LLC. Own YT.`, id), '6 · Content Studio');
  assert.equal(displayName({ id, name: id, brief: 'You are 1 · Marketing (X) for Stacc LLC. Own X.' }), '1 · Marketing (X)');
  const stub = shapeAgent({ id, name: id, brief: `You are ${id}. Your job is ${id}. Do that job.` });
  assert.equal(stub.name, 'chat');
  assert.equal(stub.brief, '');
  assert.equal(looksLikeAgentId(id, id), true);
  assert.equal(looksLikeAgentId('Marketing (X)', id), false);
});

test('mergeAgentRecords first-seen id wins', () => {
  const out = mergeAgentRecords([
    [{ id: 'a', name: 'one' }],
    [{ id: 'a', name: 'two' }, { id: 'b', name: 'bee' }],
  ]);
  assert.deepEqual(out, [{ id: 'a', name: 'one' }, { id: 'b', name: 'bee' }]);
});

test('mergeAgentRecords upgrades a UUID name from a later named pile', () => {
  const id = '4aa3490a-7f59-4222-9bab-1f416d075716';
  const out = mergeAgentRecords([
    [{ id, name: id, brief: `You are ${id}. Your job is ${id}.` }],
    [{ id, name: 'STACCs LLC CEO', brief: 'You are CEO of Stacc LLC.' }],
  ]);
  assert.equal(out[0].name, 'STACCs LLC CEO');
  assert.equal(out[0].brief, 'You are CEO of Stacc LLC.');
  const keep = mergeAgentRecords([
    [{ id, name: 'STACCs LLC CEO', brief: 'You are CEO of Stacc LLC.' }],
    [{ id, name: id, brief: `You are ${id}. Your job is ${id}.` }],
  ]);
  assert.equal(keep[0].name, 'STACCs LLC CEO');
  assert.equal(preferNamedAgent(
    { id, name: id },
    { id, name: 'Email & Infra' },
  ).name, 'Email & Infra');
});

test('rosterForEvent does not truncate a 90-agent list', () => {
  const list = Array.from({ length: 90 }, (_, i) => ({
    id: `a${i}`,
    name: `agent ${i}`,
    updatedAt: i,
  }));
  const out = rosterForEvent(list);
  assert.equal(out.length, 90);
  assert.equal(out[0].id, 'a89');
  assert.equal(out[89].id, 'a0');
  const activity = new Map([
    ['a0', { updatedAt: 10_000, hasUnread: true, unreadCount: 3 }],
  ]);
  const stamped = rosterForEvent(list, activity);
  assert.equal(stamped.length, 90);
  assert.equal(stamped[0].id, 'a0');
  assert.equal(stamped[0].hasUnread, true);
  assert.equal(stamped[0].unreadCount, 3);
});

test('deleted agents stay dead across a merge from another pile', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-del-'));
  try {
    addDeletedIds(tmp, ['gone']);
    const kept = filterDeleted([
      { id: 'gone', name: 'resurrect' },
      { id: 'stay', name: 'ok' },
    ], tmp);
    assert.deepEqual(kept.map((a) => a.id), ['stay']);
    assert.equal(readDeletedIds(tmp).has('gone'), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('filterDeleted does not tombstone grokroom threads or bubble-members', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-roomdel-'));
  try {
    addDeletedIds(tmp, ['roombot-alice', 'room-main', 'gone']);
    const kept = filterDeleted([
      { id: 'roombot-alice', name: 'alice', hidden: true },
      { id: 'room-main', name: '# main', isGroup: true },
      { id: 'gone', name: 'dead' },
    ], tmp);
    assert.deepEqual(kept.map((a) => a.id).sort(), ['room-main', 'roombot-alice']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('callerKeyFromAuth is stable per token and differs across tokens', () => {
  assert.equal(callerKeyFromAuth('Bearer abc'), callerKeyFromAuth('Bearer abc'));
  assert.notEqual(callerKeyFromAuth('Bearer abc'), callerKeyFromAuth('Bearer xyz'));
  assert.equal(callerKeyFromAuth(''), '');
});

test('parseWakeupEvery floors at 60s so never-stop cannot storm', () => {
  assert.equal(parseWakeupEvery('5m'), 300);
  assert.equal(parseWakeupEvery('1h'), 3600);
  assert.equal(parseWakeupEvery('30s'), WAKEUP_MIN_SEC);
  assert.equal(parseWakeupEvery(''), WAKEUP_DEFAULT_SEC);
  assert.equal(parseWakeupEvery('nope'), WAKEUP_DEFAULT_SEC);
});

test('wantsWakeupCron matches NEVER STOP and CRON THE WAKEUPS', () => {
  assert.equal(wantsWakeupCron('you are to NEVER STOP'), true);
  assert.equal(wantsWakeupCron('CRON THE WAKEUPS'), true);
  assert.equal(wantsWakeupCron('Bro do u need to SPAWN more bots'), false);
});

test('read/write wakeups round-trip under a temp home', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-wake-'));
  try {
    const rec = shapeWakeup('ceo-1', { every: '5m' });
    writeWakeups(tmp, { 'ceo-1': rec });
    assert.equal(wakeupsPath(tmp), path.join(tmp, '.openzoo', 'grokbot-wakeups.json'));
    const got = readWakeups(tmp);
    assert.equal(got['ceo-1'].everySec, 300);
    assert.equal(got['ceo-1'].agentId, 'ceo-1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseWakeupEvery caps at 6h and floors 30s', () => {
  assert.equal(parseWakeupEvery('90s'), 90);
  assert.equal(parseWakeupEvery('2h'), 7200);
  assert.equal(parseWakeupEvery('24h'), 6 * 3600);
  assert.equal(parseWakeupEvery('0'), WAKEUP_DEFAULT_SEC);
});

test('wantsWakeupCron matches schedule-the-wakeups phrasing', () => {
  assert.equal(wantsWakeupCron('please schedule the wakeups'), true);
  assert.equal(wantsWakeupCron('wakeups should cron every 5m'), true);
  assert.equal(wantsWakeupCron('just answer the question'), false);
});

test('shapeAgent keeps hidden + room so grokroom members stay off the tray', () => {
  const hidden = shapeAgent({ id: 'roombot-alice', name: 'alice', hidden: true });
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.hiddenFromSidebar, true);
  assert.equal(hidden.brief, '');
  const room = shapeAgent({
    id: 'room-main',
    name: '# main',
    isGroup: true,
    room: { id: 'main', addr: 'E2KzPZH6ZWzftkEaT1qYvGG9ootnDasSkCiVqtCMxuhR' },
  });
  assert.equal(room.isGroup, true);
  assert.equal(room.room.id, 'main');
  assert.equal(room.room.web, 'https://openzoo.fun/r/E2KzPZH6ZWzftkEaT1qYvGG9ootnDasSkCiVqtCMxuhR');
  assert.equal(room.hidden, false);
  assert.equal(room.brief, '');
  assert.equal(briefFromName('# main'), '');
  assert.equal(briefFromName('# bots'), '');
});

test('rosterForEvent hides bubble-members unless includeHidden', () => {
  const list = [
    { id: 'room-main', name: '# main', isGroup: true, room: { id: 'main' } },
    { id: 'roombot-alice', name: 'alice', hidden: true },
    { id: 'firstmate', name: 'Firstmate' },
  ];
  const vis = rosterForEvent(list, new Map());
  assert.deepEqual(vis.map((a) => a.id).sort(), ['firstmate', 'room-main']);
  const all = rosterForEvent(list, new Map(), { includeHidden: true });
  assert.equal(all.length, 3);
  assert.equal(all.find((a) => a.id === 'roombot-alice').hidden, true);
});

test('grokroom ids are stable and detect room vs member', () => {
  assert.equal(grokroomAgentId('main'), 'room-main');
  assert.equal(grokroomMemberId('Alice'), 'roombot-alice');
  assert.equal(grokroomMemberId('shim\'s bot'), 'roombot-shim-s-bot');
  assert.equal(isGrokRoomAgent({ id: 'room-bots', name: '# bots' }), true);
  assert.equal(isGrokRoomAgent({ id: 'x', room: { id: 'lobby' } }), true);
  assert.equal(isGrokRoomAgent({ id: 'c7929c8e-258c-4907-a0fd-58aab79144ad', name: 'Firstmate' }), false);
  assert.equal(isGrokRoomMember({ id: 'roombot-bob', hidden: true }), true);
  assert.equal(isGrokRoomMember({ id: 'firstmate', name: 'Firstmate' }), false);
});

test('grokroomShareUrl is openzoo.fun/r/<pubkey>', () => {
  const addr = 'DJgLAZuzhVwmjXSGyfEPLUDbTRYPbvQS3AC9za3cUTTm';
  assert.equal(grokroomShareUrl(addr), 'https://openzoo.fun/r/' + addr);
  assert.equal(grokroomShareUrl('nope'), '');
  assert.equal(grokroomShareUrl(''), '');
  assert.equal(agentShareUrl({ room: { id: 'main', addr } }), 'https://openzoo.fun/r/' + addr);
  const st = groupShareState({
    agent: { id: 'g1', isGroup: true },
    rooms: [{ id: 'main', name: '# main', addr }],
  });
  assert.equal(st.url, '');
  assert.equal(st.isGroup, true);
  assert.equal(st.rooms[0].url, 'https://openzoo.fun/r/' + addr);
});

test('mintOnchainRoom gives each groupchat an openzoo.fun/r/<addr>', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-gc-'));
  try {
    const rec = mintOnchainRoom({ agentId: 'g1', name: 'crew', home: tmp });
    assert.match(rec.addr, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(rec.web, 'https://openzoo.fun/r/' + rec.addr);
    const again = ensureOnchainRoom({ id: 'g1', name: 'crew' }, tmp);
    assert.equal(again.addr, rec.addr);
    const attached = attachOnchainRoom({ id: 'g1', name: 'crew', isGroup: true }, tmp);
    assert.equal(attached.room.web, rec.web);
    assert.equal(agentShareUrl(attached), rec.web);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
