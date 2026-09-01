/**
 * Grok Ship on the zoo — factory tools for the hijacked Grok Bot.
 *
 * Shape borrowed from kunchenguid/grok-ship (MIT): one Firstmate bot the
 * human talks to, one crewmate bot per repo, a worker that writes code on a
 * branch, a FRESH adversarial review of that branch, and a pull request only
 * when the review is clean. The human merges.
 *
 * What is different here, and why:
 *   - Workers are `claude-zoo -p` (open-claude-code through the :8402 proxy)
 *     in a git worktree, not Cursor cloud agents. Cloud agents bill Cursor and
 *     need Cursor's GitHub connector; the whole point of the hijack is x402
 *     per-call billing, so the coding worker must ride the zoo too.
 *   - The backlog is the forge's own issues (gh/glab) plus a small JSON ledger
 *     at ~/.openzoo/ship/tasks.json, not a SQLite file. Nothing to migrate.
 *   - The review is a one-shot zoo completion with NO chat history — that is
 *     what "fresh subagent" means in practice. It only sees the diff.
 *
 * Pure helpers take `run(cmd, cwd)` / `post(messages, model)` so tests can
 * drive them without a shell or a wallet.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHIM_ROOT = path.dirname(here);

export function shipDir(home = os.homedir()) {
  return path.join(home, '.openzoo', 'ship');
}
export function tasksPath(home = os.homedir()) {
  return path.join(shipDir(home), 'tasks.json');
}

export function loadTasks(home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(tasksPath(home), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export function saveTasks(home, tasks) {
  fs.mkdirSync(shipDir(home), { recursive: true });
  const tmp = `${tasksPath(home)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, tasksPath(home));
  return tasks;
}

export function newTaskId(now = Date.now(), rand = Math.random()) {
  const t = now.toString(36).slice(-5).toUpperCase();
  const r = Math.floor(rand * 1296).toString(36).padStart(2, '0').toUpperCase();
  return `SH-${t}${r}`;
}

export function slugBranch(taskId, title = '') {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `ship/${String(taskId).toLowerCase()}${slug ? `-${slug}` : ''}`;
}

/* ------------------------------------------------------------------ forge */

/** Pure: which forge a remote points at, and which CLI we can use for it. */
export function detectForge({ remoteUrl = '', ghAuth = false, glabAuth = false } = {}) {
  const u = String(remoteUrl || '').toLowerCase();
  let forge = 'none';
  if (/github\.com/.test(u)) forge = 'github';
  else if (/gitlab\./.test(u)) forge = 'gitlab';
  else if (/bitbucket\.org/.test(u)) forge = 'bitbucket';
  else if (/cursor\.(com|sh)|origin\./.test(u)) forge = 'origin';
  else if (u) forge = 'other';
  let cli = null;
  if (forge === 'github' && ghAuth) cli = 'gh';
  if (forge === 'gitlab' && glabAuth) cli = 'glab';
  return { forge, cli, remoteUrl: String(remoteUrl || '').trim() };
}

/** Shell-backed: ask git and the forge CLIs. `run` throws on non-zero. */
export async function probeForge(cwd, run) {
  const tryRun = async (cmd) => {
    try { return { ok: true, out: String(await run(cmd, cwd) || '') }; } catch (e) { return { ok: false, out: String(e?.message || e) }; }
  };
  const remote = await tryRun('git remote get-url origin');
  const remoteUrl = remote.ok ? remote.out.trim().split('\n')[0] : '';
  const gh = await tryRun('gh auth status');
  const glab = await tryRun('glab auth status');
  const ghAuth = gh.ok && !/not logged in/i.test(gh.out);
  const glabAuth = glab.ok && !/not logged in/i.test(glab.out);
  const base = await defaultBase(cwd, run);
  return { ...detectForge({ remoteUrl, ghAuth, glabAuth }), base, cwd };
}

export async function defaultBase(cwd, run) {
  try {
    const ref = String(await run('git symbolic-ref --short refs/remotes/origin/HEAD', cwd) || '').trim();
    const m = ref.match(/^origin\/(.+)$/);
    if (m) return m[1];
  } catch { /* fall through */ }
  for (const b of ['main', 'master']) {
    try {
      await run(`git rev-parse --verify --quiet refs/heads/${b}`, cwd);
      return b;
    } catch { /* next */ }
  }
  return 'main';
}

/* ----------------------------------------------------------------- worker */

export function workerPrompt({ taskId, title, prompt, branch, base, forge = 'none' } = {}) {
  return [
    `Task ${taskId}: ${title || '(untitled)'}`,
    '',
    String(prompt || '').trim(),
    '',
    'Working rules:',
    `- You are in a dedicated git worktree already on branch ${branch} (base ${base}). Do not switch branches.`,
    '- Implement the task. Run the project tests the way the repo runs them. Fix what you break.',
    '- Commit with clear messages. When done: `git push -u origin ' + branch + '`.',
    '- Do NOT open a pull request or merge request. A separate reviewer reads the pushed branch first.',
    `- Forge: ${forge}. Do not assume GitHub.`,
    '- Finish with a short summary: what changed, how it was tested, anything the reviewer should look at.',
  ].join('\n');
}

/** argv for the worker process. Override the binary with OPENZOO_SHIP_WORKER. */
export function workerCommand({ prompt, shimRoot = SHIM_ROOT, env = process.env } = {}) {
  const custom = env.OPENZOO_SHIP_WORKER;
  const flags = ['-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'text'];
  if (custom) return { file: custom, args: flags };
  return { file: process.execPath, args: [path.join(shimRoot, 'bin', 'claude-zoo.js'), ...flags] };
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * Create the worktree, spawn a detached worker, record the task.
 * `run(cmd, cwd)` runs shell; `spawnFn` defaults to child_process.spawn.
 */
export async function launchWorker({
  cwd, title, prompt, base, taskId, home = os.homedir(), run, spawnFn = spawn, env = process.env, log = () => {},
} = {}) {
  if (!cwd) throw new Error('cwd (repo path) is required');
  if (!prompt) throw new Error('prompt is required');
  const tasks = loadTasks(home);
  const existing = taskId ? tasks[taskId] : null;
  if (existing && isPidAlive(existing.pid)) throw new Error(`task ${taskId} still has a live worker (pid ${existing.pid})`);
  const id = existing?.id || taskId || newTaskId();
  const forge = existing
    ? { forge: existing.forge, cli: existing.cli, remoteUrl: existing.remoteUrl, base: existing.base }
    : await probeForge(cwd, run);
  const baseBranch = existing?.base || base || forge.base || 'main';
  const branch = existing?.branch || slugBranch(id, title);
  const worktree = existing?.worktree || path.join(shipDir(home), 'worktrees', id);
  const logPath = existing?.log || path.join(shipDir(home), 'logs', `${id}.log`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  if (!existing) {
    try { await run(`git fetch origin ${baseBranch}`, cwd); } catch (e) { log(`ship: fetch ${baseBranch} failed: ${e.message}`); }
    let start = `origin/${baseBranch}`;
    try { await run(`git rev-parse --verify --quiet ${start}`, cwd); } catch { start = baseBranch; }
    await run(`git worktree add -b ${branch} ${JSON.stringify(worktree)} ${start}`, cwd);
  }

  const text = workerPrompt({
    taskId: id,
    title: title || existing?.title,
    prompt: existing ? `Follow-up on the branch you (or a prior worker) already pushed. Address these review findings, keep behavior otherwise unchanged, then push again:\n${prompt}` : prompt,
    branch,
    base: baseBranch,
    forge: forge.forge,
  });
  const { file, args } = workerCommand({ prompt: text, env });
  const out = fs.openSync(logPath, 'a');
  fs.writeSync(out, `[ship] ${new Date().toISOString()} ${id} start ${file} in ${worktree}\n`);
  const child = spawnFn(file, args, {
    cwd: worktree,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...env, OPENZOO_SHIP_TASK: id },
  });
  child.unref?.();
  fs.closeSync(out);

  tasks[id] = {
    ...(existing || {}),
    id,
    title: String(title || existing?.title || ''),
    prompt: existing ? `${existing.prompt}\n\n[follow-up] ${String(prompt)}` : String(prompt),
    repo: existing?.repo || cwd,
    attempts: (existing?.attempts || 0) + 1,
    forge: forge.forge,
    cli: forge.cli,
    remoteUrl: forge.remoteUrl,
    base: baseBranch,
    branch,
    worktree,
    log: logPath,
    pid: child.pid ?? null,
    status: 'underway',
    review: null,
    result: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  saveTasks(home, tasks);
  log(`ship: ${id} worker pid=${child.pid} branch=${branch} wt=${worktree}`);
  return tasks[id];
}

export function tailFile(p, maxChars = 4000) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    return s.length > maxChars ? s.slice(-maxChars) : s;
  } catch {
    return '';
  }
}

export async function taskStatus({ taskId, home = os.homedir(), run } = {}) {
  const tasks = loadTasks(home);
  const task = tasks[taskId];
  if (!task) return { ok: false, error: `no task ${taskId}` };
  const alive = isPidAlive(task.pid);
  let commits = '';
  let pushed = false;
  try { commits = String(await run(`git log --oneline ${task.base}..${task.branch}`, task.worktree) || '').trim(); } catch { /* none yet */ }
  try {
    await run(`git fetch origin ${task.branch}`, task.worktree);
    await run(`git rev-parse --verify --quiet origin/${task.branch}`, task.worktree);
    pushed = true;
  } catch { pushed = false; }
  if (!alive && task.status === 'underway') {
    task.status = pushed ? 'pushed' : 'worker-exited';
    task.updated_at = Date.now();
    saveTasks(home, tasks);
  }
  return {
    ok: true,
    task: { id: task.id, title: task.title, branch: task.branch, base: task.base, status: task.status, result: task.result },
    worker: { pid: task.pid, alive },
    pushed,
    commits: commits.split('\n').filter(Boolean).slice(0, 30),
    logTail: tailFile(task.log, 3000),
    reviewGate: task.review ? reviewGate(task.review) : null,
  };
}

/* ----------------------------------------------------------------- review */

export const REVIEW_JSON_SHAPE = `{
  "findings": [
    { "severity": "error|warning|info", "action": "ask-user|auto-fix|no-op", "file": "path", "line": 1, "description": "..." }
  ],
  "risk_level": "low|medium|high",
  "risk_rationale": "one sentence"
}`;

/** Fresh-context review prompt. No chat history rides along on purpose. */
export function reviewMessages({ repo = '', branch, base, diff, gitlog = '', stat = '' } = {}) {
  const system = [
    'You are an adversarial code reviewer. You see only a branch diff. You have no tools and cannot run anything.',
    'Find what would go wrong if this merged: bugs, security, performance regressions, breaking changes, missing error handling, and real simplifications that keep behavior identical.',
    'Anchor every finding to a file and a 1-indexed line in the changed code. Do not report style, formatting, lint, or type-check noise. No generic advice.',
    'Severity error must not merge. warning can follow up. info is optional.',
    'action ask-user = product behavior or the author\'s intent is in question (default when unsure). auto-fix = non-functional, fixable without discussing intent. no-op = informational.',
    'Do a full pass before answering. If the change is clean, return an empty findings array.',
    `Return ONLY JSON in this shape:\n${REVIEW_JSON_SHAPE}`,
  ].join('\n');
  const user = [
    `repo: ${repo}`,
    `branch: ${branch}`,
    `base: ${base}`,
    gitlog ? `commits:\n${gitlog}` : '',
    stat ? `diffstat:\n${stat}` : '',
    'diff:',
    '```diff',
    String(diff || '').trim() || '(empty diff)',
    '```',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const SEVERITIES = new Set(['error', 'warning', 'info']);
const ACTIONS = new Set(['ask-user', 'auto-fix', 'no-op']);

/** Tolerant: fences, prose around the JSON, odd casing. Never throws. */
export function parseReview(text) {
  const s = String(text || '');
  let obj = null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1), s];
  for (const c of candidates) {
    if (!c) continue;
    try { obj = JSON.parse(c); break; } catch { /* next */ }
  }
  if (!obj || typeof obj !== 'object') {
    return {
      findings: [{ severity: 'error', action: 'no-op', file: '', line: 0, description: 'reviewer returned no JSON' }],
      risk_level: 'high',
      risk_rationale: 'review output was not parseable',
      parse_error: true,
      raw: s.slice(0, 2000),
    };
  }
  const findings = (Array.isArray(obj.findings) ? obj.findings : []).map((f) => {
    const severity = String(f?.severity || 'warning').toLowerCase();
    const action = String(f?.action || 'ask-user').toLowerCase();
    return {
      severity: SEVERITIES.has(severity) ? severity : 'warning',
      action: ACTIONS.has(action) ? action : 'ask-user',
      file: String(f?.file || ''),
      line: Number.isFinite(Number(f?.line)) ? Number(f.line) : 0,
      description: String(f?.description || '').slice(0, 1000),
    };
  });
  const risk = String(obj.risk_level || '').toLowerCase();
  return {
    findings,
    risk_level: ['low', 'medium', 'high'].includes(risk) ? risk : (findings.some((f) => f.severity === 'error') ? 'high' : 'medium'),
    risk_rationale: String(obj.risk_rationale || ''),
    parse_error: false,
  };
}

/**
 * Grok Ship's loop, as a decision:
 *   error       -> blocked, do not raise
 *   ask-user    -> blocked, one decision card to the human
 *   auto-fix    -> blocked, send back to the worker, then a FRESH review
 *   info / none -> clean, the PR may open
 */
export function reviewGate(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const errors = findings.filter((f) => f.severity === 'error');
  const askUser = findings.filter((f) => f.action === 'ask-user' && f.severity !== 'error');
  const autoFix = findings.filter((f) => f.action === 'auto-fix' && f.severity !== 'error');
  if (review?.parse_error) return { clean: false, reason: 'review did not return JSON; run ship_review again', errors, askUser, autoFix };
  if (errors.length) return { clean: false, reason: `${errors.length} error finding(s) block the PR`, errors, askUser, autoFix };
  if (autoFix.length) return { clean: false, reason: `${autoFix.length} auto-fix finding(s): send them to the worker, then review again fresh`, errors, askUser, autoFix };
  if (askUser.length) return { clean: false, reason: `${askUser.length} ask-user finding(s): one decision card to the human, do not raise`, errors, askUser, autoFix };
  return { clean: true, reason: findings.length ? 'only info findings' : 'no findings', errors, askUser, autoFix };
}

export async function defaultZooPost(messages, model, { fetchFn = fetch, port = 8402, maxTokens = 4096, timeoutMs = 10 * 60_000 } = {}) {
  const r = await fetchFn(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-openzoo' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `zoo ${r.status}`);
  const c = data?.choices?.[0]?.message?.content;
  return Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : String(c || '');
}

/**
 * Review a pushed branch with a fresh one-shot completion. Reads the branch
 * through git in the repo (or the task worktree), never a worker VM.
 */
export async function reviewBranch({
  taskId, cwd, branch, base, model, home = os.homedir(), run, post = defaultZooPost, maxDiffChars = Number(process.env.OPENZOO_SHIP_DIFF_CHARS || 160_000), log = () => {},
} = {}) {
  const tasks = loadTasks(home);
  const task = taskId ? tasks[taskId] : null;
  if (taskId && !task) return { ok: false, error: `no task ${taskId}` };
  const dir = task?.worktree || cwd;
  const br = branch || task?.branch;
  const bs = base || task?.base || (await defaultBase(dir, run));
  if (!dir || !br) return { ok: false, error: 'need taskId, or cwd + branch' };

  try { await run(`git fetch origin ${br}`, dir); } catch (e) { log(`ship: fetch ${br} ${e.message}`); }
  let tip = br;
  try { await run(`git rev-parse --verify --quiet origin/${br}`, dir); tip = `origin/${br}`; } catch { /* local branch */ }
  const stat = String(await run(`git diff --stat ${bs}...${tip}`, dir) || '').trim();
  let diff = String(await run(`git diff ${bs}...${tip}`, dir) || '');
  const gitlog = String(await run(`git log --oneline ${bs}..${tip}`, dir) || '').trim();
  if (!diff.trim()) return { ok: false, error: `no diff between ${bs} and ${tip}; has the worker pushed?` };
  let truncated = false;
  if (diff.length > maxDiffChars) { diff = `${diff.slice(0, maxDiffChars)}\n… (diff truncated at ${maxDiffChars} chars)`; truncated = true; }

  const messages = reviewMessages({ repo: task?.repo || dir, branch: br, base: bs, diff, gitlog, stat });
  log(`ship: review ${br} vs ${bs} diff=${diff.length}c model=${model}`);
  const text = await post(messages, model);
  const review = parseReview(text);
  const gate = reviewGate(review);
  if (task) {
    task.review = { ...review, reviewed_at: Date.now(), tip, truncated };
    task.status = gate.clean ? 'review-clean' : 'review-blocked';
    task.updated_at = Date.now();
    saveTasks(home, tasks);
  }
  return { ok: true, taskId: task?.id || null, branch: br, base: bs, truncated, review, gate };
}

/* --------------------------------------------------------------------- PR */

export function prCommand({ cli, branch, base, title, body = '' } = {}) {
  const t = JSON.stringify(String(title || branch));
  const b = JSON.stringify(String(body || ''));
  if (cli === 'gh') return `gh pr create --head ${branch} --base ${base} --title ${t} --body ${b}`;
  if (cli === 'glab') return `glab mr create --source-branch ${branch} --target-branch ${base} --title ${t} --description ${b} --yes`;
  throw new Error(`no authenticated forge CLI for this repo (cli=${cli || 'none'}); push is visible but the PR must be opened by hand`);
}

export async function openPr({ taskId, title, body, home = os.homedir(), run, log = () => {} } = {}) {
  const tasks = loadTasks(home);
  const task = tasks[taskId];
  if (!task) return { ok: false, error: `no task ${taskId}` };
  if (!task.review) return { ok: false, error: 'no review on record; run ship_review first' };
  const gate = reviewGate(task.review);
  if (!gate.clean) return { ok: false, error: `review not clean: ${gate.reason}`, gate };
  try {
    await run(`git fetch origin ${task.branch}`, task.repo);
    await run(`git rev-parse --verify --quiet origin/${task.branch}`, task.repo);
  } catch {
    return { ok: false, error: `branch ${task.branch} is not on origin yet` };
  }
  const summary = body || [
    task.title,
    '',
    task.prompt,
    '',
    `Adversarial review: ${gate.reason} (risk ${task.review.risk_level}).`,
    `Ship task ${task.id}.`,
  ].join('\n');
  const cmd = prCommand({ cli: task.cli, branch: task.branch, base: task.base, title: title || task.title || task.branch, body: summary });
  log(`ship: ${task.id} ${cmd.slice(0, 80)}`);
  const out = String(await run(cmd, task.repo) || '');
  const url = out.match(/https?:\/\/\S+/)?.[0] || out.trim();
  task.result = url;
  task.status = 'pr-open';
  task.updated_at = Date.now();
  saveTasks(home, tasks);
  return { ok: true, taskId: task.id, url, branch: task.branch, base: task.base };
}

/* ------------------------------------------------------------------ briefs */

export function firstmateBrief() {
  return [
    'You are Firstmate: the one bot the human talks to. They bring you everything; you make sure it gets done.',
    'Other sidebar bots are crewmates with standing briefs, one per repo. Before creating one, list_agents and reuse a crewmate whose brief already covers the repo.',
    'Hand work off with message_agent. Tag every hand-off with a short task id and ask for the outcome back against that id. Empty results still get reported.',
    'Code goes through a crewmate, never through you. You never call ship_launch_worker, ship_review, or ship_open_pr yourself.',
    'Classify factory work as scout (a report, never a PR) or ship (a branch, a fresh adversarial review, then a PR). Ship only when the human authorized the change.',
    'Nothing merges without the human\'s explicit word. Relay PR URLs when they land. Bring decisions one at a time: what, why now, real options, your recommendation.',
    'Detect the forge (GitHub, GitLab, Bitbucket, Origin). Do not assume GitHub. Speak in outcomes, not mechanics. Prefer schedule_wakeup over spawning more bots.',
  ].join(' ');
}

export function crewmateBrief({ repo, forge = 'unknown' } = {}) {
  return [
    `You are the crewmate for the repo at ${repo} (forge: ${forge}). Firstmate hands you tasks with an id; report every outcome back to Firstmate against that id with message_agent.`,
    'Scout: investigate with read_file / exec (git log, grep, tests). Write the report to ~/.openzoo/ship/reports/<task id>.md and return the path. Never a PR.',
    'Ship: ship_launch_worker with cwd=the repo, a clear prompt (goal, acceptance criteria, constraints). Poll ship_status until the worker exits and the branch is pushed.',
    'Then ship_review on the task. If the gate is not clean: for auto-fix findings call ship_launch_worker again with the same task id and the findings as the prompt (same branch, same worktree); ask-user findings go to Firstmate as one decision; error findings block. Review again fresh after any fix.',
    'Only when ship_review reports gate.clean: ship_open_pr. Relay the URL. Never merge; the human does.',
    'Use the forge CLI recorded for this repo (gh or glab) via exec for issues and checks. Do not assume GitHub.',
  ].join(' ');
}
