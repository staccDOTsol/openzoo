import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectForge,
  slugBranch,
  newTaskId,
  parseReview,
  reviewGate,
  reviewMessages,
  prCommand,
  workerPrompt,
  workerCommand,
  loadTasks,
  saveTasks,
  launchWorker,
  reviewBranch,
  openPr,
  taskStatus,
  firstmateBrief,
  crewmateBrief,
} from '../lib/ship.js';
import { LOCAL_TOOL_NAMES, shipNudgeText } from '../lib/cursorbackend.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oz-ship-'));

test('detectForge: host decides the forge, auth decides the CLI, never assumes GitHub', () => {
  assert.deepEqual(detectForge({ remoteUrl: 'git@github.com:a/b.git', ghAuth: true }), { forge: 'github', cli: 'gh', remoteUrl: 'git@github.com:a/b.git' });
  assert.equal(detectForge({ remoteUrl: 'https://github.com/a/b', ghAuth: false }).cli, null);
  assert.equal(detectForge({ remoteUrl: 'https://gitlab.com/a/b.git', glabAuth: true }).cli, 'glab');
  assert.equal(detectForge({ remoteUrl: 'https://bitbucket.org/a/b' }).forge, 'bitbucket');
  assert.equal(detectForge({ remoteUrl: 'https://origin.cursor.com/a/b' }).forge, 'origin');
  assert.equal(detectForge({ remoteUrl: '' }).forge, 'none');
});

test('slugBranch + newTaskId are branch-safe', () => {
  const id = newTaskId(1725200000000, 0.5);
  assert.match(id, /^SH-[0-9A-Z]{5}[0-9A-Z]{2}$/);
  assert.equal(slugBranch('SH-ABC12', 'Fix the 402 copy!! (Whop)'), 'ship/sh-abc12-fix-the-402-copy-whop');
  assert.equal(slugBranch('SH-ABC12'), 'ship/sh-abc12');
});

test('parseReview tolerates fences and prose, normalizes bad enums, never throws', () => {
  const fenced = parseReview('Here you go:\n```json\n{"findings":[{"severity":"ERROR","action":"weird","file":"a.js","line":"7","description":"x"}],"risk_level":"HIGH","risk_rationale":"r"}\n```');
  assert.equal(fenced.findings[0].severity, 'error');
  assert.equal(fenced.findings[0].action, 'ask-user');
  assert.equal(fenced.findings[0].line, 7);
  assert.equal(fenced.risk_level, 'high');
  const bare = parseReview('{"findings":[],"risk_level":"low","risk_rationale":"clean"}');
  assert.deepEqual(bare.findings, []);
  const junk = parseReview('I cannot review this.');
  assert.equal(junk.parse_error, true);
  assert.equal(junk.risk_level, 'high');
});

test('reviewGate follows the Grok Ship loop: error/auto-fix/ask-user block, info passes', () => {
  const f = (severity, action) => ({ severity, action, file: 'x', line: 1, description: 'd' });
  assert.equal(reviewGate({ findings: [] }).clean, true);
  assert.equal(reviewGate({ findings: [f('info', 'no-op')] }).clean, true);
  assert.equal(reviewGate({ findings: [f('warning', 'auto-fix')] }).clean, false);
  assert.match(reviewGate({ findings: [f('warning', 'auto-fix')] }).reason, /worker/);
  assert.equal(reviewGate({ findings: [f('warning', 'ask-user')] }).clean, false);
  assert.match(reviewGate({ findings: [f('warning', 'ask-user')] }).reason, /decision/);
  assert.equal(reviewGate({ findings: [f('error', 'no-op')] }).clean, false);
  assert.equal(reviewGate({ findings: [], parse_error: true }).clean, false);
});

test('reviewMessages is fresh: system + one user turn, carries the diff and the JSON shape', () => {
  const m = reviewMessages({ repo: '/r', branch: 'ship/x', base: 'main', diff: '+++ b/a.js\n+bad()', gitlog: 'abc fix', stat: ' a.js | 1 +' });
  assert.equal(m.length, 2);
  assert.equal(m[0].role, 'system');
  assert.match(m[0].content, /risk_level/);
  assert.match(m[0].content, /no tools/i);
  assert.match(m[1].content, /\+bad\(\)/);
  assert.match(m[1].content, /branch: ship\/x/);
});

test('prCommand per forge CLI; no CLI is a clear error', () => {
  assert.match(prCommand({ cli: 'gh', branch: 'ship/a', base: 'main', title: 't', body: 'b' }), /^gh pr create --head ship\/a --base main/);
  assert.match(prCommand({ cli: 'glab', branch: 'ship/a', base: 'main', title: 't' }), /^glab mr create --source-branch ship\/a --target-branch main/);
  assert.throws(() => prCommand({ cli: null, branch: 'x', base: 'main' }), /no authenticated forge CLI/);
});

test('workerPrompt forbids the PR and demands a push; workerCommand runs claude-zoo -p by default', () => {
  const p = workerPrompt({ taskId: 'SH-1', title: 'T', prompt: 'do it', branch: 'ship/sh-1-t', base: 'main', forge: 'gitlab' });
  assert.match(p, /Do NOT open a pull request/);
  assert.match(p, /git push -u origin ship\/sh-1-t/);
  assert.match(p, /Forge: gitlab/);
  const c = workerCommand({ prompt: 'x', shimRoot: '/shim', env: {} });
  assert.equal(c.file, process.execPath);
  assert.equal(c.args[0], path.join('/shim', 'bin', 'claude-zoo.js'));
  assert.deepEqual(c.args.slice(1, 3), ['-p', 'x']);
  assert.ok(c.args.includes('bypassPermissions'));
  assert.equal(workerCommand({ prompt: 'x', env: { OPENZOO_SHIP_WORKER: '/usr/bin/true' } }).file, '/usr/bin/true');
});

test('tasks ledger round-trips and tolerates garbage', () => {
  const home = tmpHome();
  assert.deepEqual(loadTasks(home), {});
  saveTasks(home, { 'SH-1': { id: 'SH-1' } });
  assert.equal(loadTasks(home)['SH-1'].id, 'SH-1');
  fs.writeFileSync(path.join(home, '.openzoo', 'ship', 'tasks.json'), '[]');
  assert.deepEqual(loadTasks(home), {});
});

test('launchWorker: worktree from origin/base, detached worker, ledger row; resume reuses the branch', async () => {
  const home = tmpHome();
  const calls = [];
  const run = async (cmd, cwd) => {
    calls.push(cmd);
    if (cmd === 'git remote get-url origin') return 'git@github.com:a/b.git\n';
    if (cmd === 'gh auth status') return 'Logged in to github.com';
    if (cmd === 'glab auth status') throw new Error('not found');
    if (cmd.startsWith('git symbolic-ref')) return 'origin/main\n';
    return '';
  };
  const spawned = [];
  const spawnFn = (file, args, opts) => { spawned.push({ file, args, opts }); return { pid: 999999, unref() {} }; };
  const t = await launchWorker({ cwd: '/repo', title: 'Add thing', prompt: 'add the thing', home, run, spawnFn, env: { OPENZOO_SHIP_WORKER: '/usr/bin/true' } });
  assert.match(t.branch, /^ship\/sh-[0-9a-z]+-add-thing$/);
  assert.equal(t.base, 'main');
  assert.equal(t.cli, 'gh');
  assert.equal(t.status, 'underway');
  assert.ok(calls.some((c) => c.startsWith(`git worktree add -b ${t.branch}`) && c.endsWith(' origin/main')));
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.cwd, t.worktree);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.env.OPENZOO_SHIP_TASK, t.id);
  assert.match(spawned[0].args[1], /add the thing/);
  assert.equal(loadTasks(home)[t.id].branch, t.branch);

  // resume: same branch/worktree, no second worktree add, follow-up prompt
  calls.length = 0;
  const t2 = await launchWorker({ cwd: '/repo', prompt: 'fix finding 1', taskId: t.id, home, run, spawnFn, env: { OPENZOO_SHIP_WORKER: '/usr/bin/true' } });
  assert.equal(t2.branch, t.branch);
  assert.equal(t2.attempts, 2);
  assert.ok(!calls.some((c) => c.startsWith('git worktree add')));
  assert.match(spawned[1].args[1], /Follow-up/);
  assert.match(spawned[1].args[1], /fix finding 1/);
});

test('reviewBranch reads origin/<branch>, posts a fresh one-shot, stores gate; openPr refuses until clean', async () => {
  const home = tmpHome();
  saveTasks(home, {
    'SH-T1': { id: 'SH-T1', title: 'T', prompt: 'p', repo: '/repo', worktree: '/wt', branch: 'ship/sh-t1', base: 'main', cli: 'gh', pid: null, status: 'pushed', review: null },
  });
  const run = async (cmd) => {
    if (cmd.startsWith('git diff --stat')) return ' a.js | 2 +-';
    if (cmd.startsWith('git diff ')) return '+++ b/a.js\n-old\n+new';
    if (cmd.startsWith('git log')) return 'abc change';
    if (cmd.startsWith('gh pr create')) return 'https://github.com/a/b/pull/7\n';
    return '';
  };
  let posted;
  const post = async (messages, model) => {
    posted = { messages, model };
    return '{"findings":[{"severity":"warning","action":"auto-fix","file":"a.js","line":2,"description":"null check"}],"risk_level":"medium","risk_rationale":"r"}';
  };
  const r1 = await reviewBranch({ taskId: 'SH-T1', model: 'm', home, run, post });
  assert.equal(r1.ok, true);
  assert.equal(r1.gate.clean, false);
  assert.equal(posted.model, 'm');
  assert.equal(posted.messages.length, 2, 'no chat history rides along');
  assert.equal(loadTasks(home)['SH-T1'].status, 'review-blocked');

  const blocked = await openPr({ taskId: 'SH-T1', home, run });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /review not clean/);

  const r2 = await reviewBranch({ taskId: 'SH-T1', model: 'm', home, run, post: async () => '{"findings":[],"risk_level":"low","risk_rationale":"ok"}' });
  assert.equal(r2.gate.clean, true);
  const pr = await openPr({ taskId: 'SH-T1', home, run });
  assert.equal(pr.ok, true);
  assert.equal(pr.url, 'https://github.com/a/b/pull/7');
  assert.equal(loadTasks(home)['SH-T1'].status, 'pr-open');

  const st = await taskStatus({ taskId: 'SH-T1', home, run });
  assert.equal(st.ok, true);
  assert.equal(st.worker.alive, false);
  assert.equal(st.reviewGate.clean, true);
});

test('reviewBranch with no diff says so instead of reviewing nothing', async () => {
  const home = tmpHome();
  const r = await reviewBranch({ cwd: '/repo', branch: 'ship/x', base: 'main', model: 'm', home, run: async () => '', post: async () => { throw new Error('must not post'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no diff/);
});

test('briefs name the tools and the gate; ship tools are registered for bots', () => {
  assert.match(firstmateBrief(), /never call ship_launch_worker/);
  assert.match(firstmateBrief(), /Do not assume GitHub/);
  const c = crewmateBrief({ repo: '/r', forge: 'github' });
  assert.match(c, /crewmate for the repo at \/r/);
  assert.match(c, /ship_review/);
  assert.match(c, /Never merge/);
  for (const t of ['ship_crew', 'ship_forge', 'ship_launch_worker', 'ship_status', 'ship_review', 'ship_open_pr']) {
    assert.ok(LOCAL_TOOL_NAMES.includes(t), t);
  }
});

test('overlay nudges its user to set up Grok Ship, with the exact phrase to type', () => {
  const n = shipNudgeText();
  assert.match(n, /^\[grok ship\]/);
  assert.match(n, /set up Grok Ship for ~\/path\/to\/repo/);
  assert.match(n, /You merge/);
});
