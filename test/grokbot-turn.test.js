import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createZooTurnQueue,
  formatZooProgress,
  formatZooToolLine,
  toolResultText,
  normalizeExecFrame,
  execShell,
  localExecFrame,
  shellStreamOf,
  combinedAbortSignal,
  isSupersededError,
  LOCAL_TOOL_NAMES,
  looksStoppedReply,
  selectedPageId,
  canonicalZooModel,
  capTools,
  MAX_TOOLS,
  foldSameRole,
} from '../lib/cursorbackend.js';
import { mapImageClick, resolveAppName } from '../lib/grokbotDesktop.js';
import { mediaKindOf } from '../lib/models.js';

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
  const listed = formatZooToolLine({
    name: 'list_dir',
    args: { path: '/Users/' },
    result: { entries: ['Shared', 'stacc'] },
  });
  assert.doesNotMatch(listed, /\[object Object\]/);
  assert.match(listed, /list_dir/);
  assert.match(listed, /Shared/);
  assert.equal(toolResultText({ entries: ['a'] }), '{"entries":["a"]}');
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

test('click tools and the openzoo/auto default are wired', () => {
  assert.match(src, /DEFAULT_ZOO_MODEL = 'openzoo\/auto'/);
  assert.match(src, /\|\| DEFAULT_ZOO_MODEL/);
  assert.match(src, /zai-org\/glm-5\.3-flash/);
  assert.match(src, /desktopAction\('click'/);
  assert.match(src, /You CAN click the Mac/);
  assert.match(src, /Do not tell the user to click/);
  assert.match(src, /underfunded-nudge/);
  assert.match(src, /Do not say you have no money/);
});

test('normalizeExecFrame digs shell output out of nested helper frames', () => {
  const nested = normalizeExecFrame({
    kind: 'exec-result',
    requestId: 'r1',
    message: { stdout: 'total 0\ndrwx  Shared', stderr: '', exitCode: 0 },
  });
  assert.equal(nested.stdout, 'total 0\ndrwx  Shared');
  assert.equal(nested.exitCode, 0);
  const flat = normalizeExecFrame({ kind: 'result', stdout: 'hi', stderr: 'boom', exit_code: 2 });
  assert.equal(flat.stdout, 'hi');
  assert.equal(flat.stderr, 'boom');
  assert.equal(flat.exitCode, 2);
  const worst = normalizeExecFrame({ kind: 'client', clientMessage: { data: { output: 'ok' } } });
  assert.equal(worst.stdout, 'ok');
  // Nothing recognizable still has to be text, never [object Object].
  const opaque = normalizeExecFrame({ kind: 'result', weird: { a: 1 } });
  assert.doesNotMatch(`${opaque.message}`, /\[object Object\]/);
  assert.match(opaque.message, /"weird"/);
});

test('local-exec frame is agent.v1.ExecServerMessage, not a flat command', () => {
  const f = localExecFrame('ls -lha ~', '/home/u', 55);
  assert.equal(f.kind, 'exec');
  assert.ok(f.requestId && f.approvalId, 'daemon gates exec on an approvalId');
  // buildLocalExecManager registers shellStreamArgs, NOT shellArgs.
  assert.deepEqual(f.serverMessage, {
    shellStreamArgs: { command: 'ls -lha ~', workingDirectory: '/home/u', timeout: 55 },
  });
  assert.equal(f.authorizedByStanding, true);
  assert.equal(f.serverMessage.command, undefined);
  assert.equal(f.serverMessage.shellArgs, undefined);
  assert.doesNotMatch(src, /serverMessage: \{ command:/);
});

test('a daemon throw frame reads as an error, not raw JSON', () => {
  const n = normalizeExecFrame({
    kind: 'control',
    requestId: 'f6908d05',
    message: { throw: { id: 1, error: 'No handler found for server message of type undefined' } },
  });
  assert.match(n.error, /^local-exec: No handler found/);
  assert.doesNotMatch(n.error, /\{|"kind"/);
  // The daemon streams the body before it closes; dropping those frames meant
  // waiting out the 45s timeout on a command that had already answered.
  assert.match(src, /f\.kind === 'output' \|\| f\.kind === 'stdout'/);
  assert.match(src, /f\.kind === 'exit'/);
  assert.match(src, /localExecWaiterFor/);
});

test('shellStreamOf reads the ShellStream oneof and heartbeats are not results', () => {
  const out = shellStreamOf({ kind: 'client', requestId: 'r', message: { id: 3, shellStream: { stdout: { data: 'total 0\n' } } } });
  assert.equal(out.stdout.data, 'total 0\n');
  const exit = shellStreamOf({ kind: 'client', message: { shellStream: { exit: { code: 0, cwd: '/home/u' } } } });
  assert.equal(exit.exit.code, 0);
  // A heartbeat is a control frame with no shellStream; it must not resolve.
  assert.equal(shellStreamOf({ kind: 'control', message: { heartbeat: { id: 3 } } }), null);
  assert.equal(shellStreamOf({ kind: 'control', message: { throw: { error: 'x' } } }), null);
  assert.match(src, /f\.message\.heartbeat/);
  assert.match(src, /if \(ss\.exit\)/);
});

test('exec picks a shell that exists on this platform', () => {
  assert.deepEqual(execShell('ls', 'darwin'), { file: '/bin/zsh', args: ['-lc', 'ls'] });
  const win = execShell('dir', 'win32');
  assert.match(win.file, /cmd\.exe$|COMMAND\.COM$/i);
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'dir']);
  const nix = execShell('ls', 'linux');
  assert.notEqual(nix.file, '/bin/zsh');
  assert.match(nix.file, /\/(bash|sh)$/);
  assert.equal(nix.args[nix.args.length - 1], 'ls');
  assert.doesNotMatch(src, /execFileAsync\('\/bin\/zsh'/);
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

test('every grok spelling, including x-ai/grok-4.6, lands on the bare bazaar id', () => {
  for (const id of ['grok', 'grok-4', 'grok-4.6', 'x-ai/grok-4.6', 'X-AI/GROK-4.6']) assert.equal(canonicalZooModel(id), 'grok-4.6');
  for (const id of ['auto', 'openrouter/auto', 'openzoo/auto']) assert.equal(canonicalZooModel(id), 'openzoo/auto');
  assert.equal(canonicalZooModel('anthropic/fable-5.1'), 'anthropic/claude-fable-5.1');
  assert.equal(canonicalZooModel('anthropic/claude-fable-5'), 'anthropic/claude-fable-5');
});

test('capTools keeps locals and browser MCPs, drops the tail past 128', () => {
  const mk = (n) => ({ type: 'function', function: { name: n, parameters: { type: 'object', properties: {} } } });
  const locals = LOCAL_TOOL_NAMES.map(mk);
  const browser = Array.from({ length: 58 }, (_, i) => mk(`${i % 2 ? 'brave' : 'chrome'}-devtools__t${i}`));
  const other = Array.from({ length: 60 }, (_, i) => mk(`styxx__t${i}`));
  const capped = capTools([...other, ...browser, ...locals]);
  assert.equal(capped.length, MAX_TOOLS);
  for (const n of LOCAL_TOOL_NAMES) assert.ok(capped.some((t) => t.function.name === n), n);
  assert.equal(capped.filter((t) => /devtools__/.test(t.function.name)).length, 58);
  assert.ok(capped.filter((t) => /^styxx__/.test(t.function.name)).length < 60);
  assert.equal(capTools(locals).length, locals.length);
});

test('a video/image model row turns the prompt into a render, not a chat', () => {
  assert.equal(mediaKindOf({ id: 'ByteDance/Seedance-2.5', kind: 'video', endpoint: '/v1/videos/generations' }), 'video');
  assert.equal(mediaKindOf({ id: 'x', endpoint: '/v1/images/generations' }), 'image');
  assert.equal(mediaKindOf({ id: 'x-ai/grok-4.6', pricing: { prompt: 1, completion: 2 } }), null);
  assert.match(src, /mediaTurn\(\{ model, kind: mediaKind/);
  assert.match(src, /\/v1\/\$\{kind\}s\/generations/);
});

test('history folds same-role neighbours so strict providers accept it', () => {
  const out = foldSameRole([
    { role: 'system', content: 's' },
    { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' },
    { role: 'assistant', content: 'x' }, { role: 'assistant', content: 'y' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1' }] }, { role: 'tool', tool_call_id: '1', content: 'r' },
    { role: 'assistant', content: 'z' },
  ]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'assistant', 'tool', 'assistant']);
  assert.equal(out[1].content, 'a\n\nb\n\nc');
  assert.equal(out[2].content, 'x\n\ny');
});

test('an assistant entry with null content and no tool_calls is dropped from history', () => {
  const out = foldSameRole([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: null },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1' }] },
    { role: 'tool', tool_call_id: '1', content: 'r' },
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(out[0].content, 'a\n\nb');
});

test('an empty finish=length reply is said once, never re-bought', () => {
  assert.match(src, /empty finish=length — not re-buying/);
  assert.match(src, /reasoning_content \?\? msg\?\.reasoning/);
});

test('history strips upstream-echo keys off assistant turns', () => {
  const out = foldSameRole([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: null, refusal: null, reasoning: 'hmm', annotations: [], name: null, tool_call_id: null, function_call: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r' },
  ]);
  assert.deepEqual(Object.keys(out[1]).sort(), ['role', 'tool_calls']);
  assert.equal(out.length, 3);
});

test('max_tokens defaults to 32768 and clamps to the catalog cap', () => {
  assert.match(src, /OPENZOO_ASK_MAX_TOKENS \|\| 32768/);
  assert.match(src, /max_output_tokens \?\? row\?\.top_provider\?\.max_completion_tokens/);
});

test('local-tool permission seed unblocks exec approval', async () => {
  const { seedGrokBotLocalToolPermission } = await import('../lib/grokcli.js');
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const home = fsp.mkdtempSync(path.join(os.tmpdir(), 'oz-perm-'));
  const dir = path.join(home, 'Library', 'Application Support', 'Grok Bot');
  fsp.mkdirSync(dir, { recursive: true });
  // A ceiling of "ask" clamps the choice back down, so the seed must drop it.
  fsp.writeFileSync(path.join(dir, 'settings.json'),
    JSON.stringify({ hasSeenOnboarding: true, localToolPermission: 'ask', localToolPermissionCeiling: 'ask' }));
  const out = seedGrokBotLocalToolPermission({ home, env: {}, platform: 'darwin' });
  assert.ok(out.written.length >= 1);
  const got = JSON.parse(fsp.readFileSync(out.written[0], 'utf8'));
  assert.equal(got.localToolPermission, 'always');
  assert.equal('localToolPermissionCeiling' in got, false);
  assert.equal(got.hasSeenOnboarding, true, 'must not clobber other settings');
});
