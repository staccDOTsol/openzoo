import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createZooTurnQueue,
  formatZooProgress,
  formatZooToolLine,
  combinedAbortSignal,
  isSupersededError,
  LOCAL_TOOL_NAMES,
  looksStoppedReply,
  selectedPageId,
} from '../lib/cursorbackend.js';
import { mapImageClick, resolveAppName } from '../lib/grokbotDesktop.js';

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/cursorbackend.js'),
  'utf8',
);

test('LOCAL_TOOLS includes screenshot, click/type, and create_agent', () => {
  assert.deepEqual(
    LOCAL_TOOL_NAMES,
    [
      'read_file', 'write_file', 'exec', 'list_dir', 'screenshot',
      'click', 'type_text', 'key', 'ui_tree', 'focus_app', 'open_url',
      'create_agent', 'set_brief', 'list_agents', 'message_agent',
      'schedule_wakeup', 'cancel_wakeup',
      'ship_crew', 'ship_forge', 'ship_launch_worker', 'ship_status', 'ship_review', 'ship_open_pr',
      'x_claim', 'x_done', 'x_release', 'x_claims', 'x_compose', 'x_open', 'x_close',
    ],
  );
});

test('formatZooProgress is a visible working line', () => {
  const note = formatZooProgress({
    step: 2,
    maxSteps: 32,
    names: ['exec', 'screenshot'],
    command: 'osascript -e tell',
  });
  assert.match(note, /^Working on your Mac \(step 3\/32\): exec, screenshot/);
  assert.match(note, /osascript/);
});

test('formatZooToolLine summarizes each call for the canvas', () => {
  const execLine = formatZooToolLine({
    name: 'exec',
    args: { command: 'osascript -e tell application "Brave Browser" to activate' },
    result: 'tab 1 https://dashboard.stripe.com/acct\nmore',
  });
  assert.match(execLine, /^→ exec "/);
  assert.match(execLine, /osascript/);
  assert.match(execLine, /dashboard\.stripe\.com/);
  const shot = formatZooToolLine({
    name: 'screenshot',
    args: {},
    result: JSON.stringify({ ok: true, path: '/tmp/oz.jpg', bytes: 182001 }),
  });
  assert.equal(shot, '→ screenshot\n/tmp/oz.jpg 182001b ok');
});

test('turn queue aborts the previous nonce for the same agent', () => {
  const q = createZooTurnQueue();
  const a = q.begin('agent-1', 'n1');
  assert.equal(q.isCurrent('agent-1', 'n1'), true);
  const b = q.begin('agent-1', 'n2');
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  assert.equal(q.isCurrent('agent-1', 'n1'), false);
  assert.equal(q.isCurrent('agent-1', 'n2'), true);
  assert.equal(q.abort('agent-1'), 1);
  assert.equal(b.signal.aborted, true);
  assert.equal(q.isCurrent('agent-1', 'n2'), false);
  assert.equal(q.abort('agent-1'), 0);
});

test('turn queue does not abort a different agent', () => {
  const q = createZooTurnQueue();
  const a = q.begin('a', 'n1');
  q.begin('b', 'n1');
  assert.equal(a.signal.aborted, false);
  assert.equal(q.isCurrent('a', 'n1'), true);
  assert.equal(q.busy('a'), true);
  assert.equal(q.busy('missing'), false);
});

test('isSupersededError matches cancel, not a zoo timeout', () => {
  assert.equal(isSupersededError(new Error('superseded')), true);
  assert.equal(isSupersededError(new Error('interrupted')), true);
  assert.equal(isSupersededError(new Error('This operation was aborted')), false);
  assert.equal(isSupersededError(new Error('ETIMEDOUT')), false);
});

test('combinedAbortSignal aborts when either side aborts', async () => {
  const a = new AbortController();
  const t = AbortSignal.timeout(30_000);
  const s = combinedAbortSignal(a.signal, t);
  assert.equal(s.aborted, false);
  a.abort(new Error('superseded'));
  assert.equal(s.aborted, true);
});

test('sendPrompt cancels in-flight zoo and interruptAgentRun is local', () => {
  assert.match(src, /zooTurns\.begin\(agentId, nonce\)/);
  assert.match(src, /sendPrompt superseded/);
  assert.match(src, /if \(name === 'interruptAgentRun'\)/);
  assert.match(src, /zooTurns\.abort\(id\)/);
  assert.doesNotMatch(src, /'interruptAgentRun', 'requestDiskSaverAudit'/);
});

test('tool-loop progress is painted and screenshots attach as images', () => {
  assert.match(src, /onProgress/);
  assert.match(src, /paintChatUpdate/);
  assert.match(src, /formatZooToolLine/);
  assert.match(src, /Working on your Mac/);
  assert.match(src, /pendingVision/);
  assert.match(src, /type: 'image_url'/);
  assert.match(src, /screencapture/);
  assert.doesNotMatch(src, /function paintWorking/);
});

test('history skips ephemeral working bubbles', () => {
  assert.match(src, /if \(e\.ephemeral\) continue;/);
});

test('looksStoppedReply still catches the park copy', () => {
  assert.equal(looksStoppedReply('Stopped on research. No app files written this turn'), true);
});

test('wakeups do not fire during Grok Bot boot', () => {
  assert.match(src, /90_000/);
});

test('wakeup skips the focused canvas so the composer stays usable', () => {
  assert.match(src, /wakeup skip focused/);
  assert.match(src, /addDeletedIds/);
});

test('wakeup cron is a host timer, not spawn', () => {
  assert.match(src, /schedule_wakeup/);
  assert.match(src, /wantsWakeupCron/);
  assert.match(src, /restoreAgentWakeups/);
  assert.match(src, /zooTurns\.busy/);
  assert.match(src, /Do not spawn more bots for persistence/);
});

test('click tools and the bare grok-4.6 default are wired', () => {
  assert.match(src, /DEFAULT_ZOO_MODEL = 'grok-4\.6'/);
  assert.match(src, /\|\| DEFAULT_ZOO_MODEL/);
  assert.match(src, /zai-org\/glm-5\.3-flash/);
  assert.match(src, /desktopAction\('click'/);
  assert.match(src, /You CAN click the Mac/);
  assert.match(src, /Do not tell the user to click/);
  assert.match(src, /underfunded-nudge/);
  assert.match(src, /Do not say you have no money/);
});

test('formatZooToolLine summarizes click x,y', () => {
  const line = formatZooToolLine({ name: 'click', args: { x: 400, y: 800 }, result: '{"ok":true}' });
  assert.match(line, /^→ click "400,800"/);
});

test('mapImageClick scales screenshot pixels to screen points', () => {
  const p = mapImageClick(700, 450, {
    image: { width: 1400, height: 900 },
    screen: { width: 1512, height: 982 },
  });
  assert.equal(p.x, 756);
  assert.equal(p.y, 491);
  assert.equal(resolveAppName('brave'), 'Brave Browser');
});

test('selectedPageId reads the [selected] page out of chrome-devtools output', () => {
  assert.equal(selectedPageId('## Pages\n1: https://x.com/a (Home)\n2: https://x.com/b [selected]\n3: about:blank'), 2);
  assert.equal(selectedPageId('nothing'), null);
});
