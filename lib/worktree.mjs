// Desktop grokui SPAWN isolation — Claude Code worktrees + UltraCode
// spawn_agent_worktree. Not ported to iOS/Android/Seeker/PSG1 (no local FS).
//
// Git goes through dugite's bundled binary, never PATH `git`.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readdirSync,
  readFileSync, rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setupEnvironment } from 'dugite';

const FETCH_MS = 8000;
const GIT_MS = 15000;

export function agentSlug(name) {
  const pr = parsePrRef(name);
  if (pr) return `pr-${pr.n}`;
  const s = String(name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || 'agent';
}

/** #123, GitHub PR URL, GitLab MR URL, or a generic /pull/N. */
export function parsePrRef(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const hash = /^#(\d+)\b/.exec(s);
  if (hash) return { n: Number(hash[1]) };
  const gh = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i.exec(s);
  if (gh) return { n: Number(gh[1]), host: 'github.com' };
  const gl = /gitlab\.com\/\S+\/-\/merge_requests\/(\d+)/i.exec(s);
  if (gl) return { n: Number(gl[1]), host: 'gitlab.com' };
  const pull = /\/pull\/(\d+)\b/i.exec(s);
  if (pull) return { n: Number(pull[1]) };
  return null;
}

export function extractPrFromSpawn(name, spec) {
  const fromName = parsePrRef(name);
  if (fromName) return fromName;
  const body = String(spec || '').trim();
  if (!body) return null;
  const first = body.split(/\s+/)[0];
  return parsePrRef(first) || parsePrRef(body.split('|')[0].trim()) || parsePrRef(body);
}

/** github.com → pull/N/head; gitlab.com → merge-requests/N/head; else pull first. */
export function fetchSpecsForOrigin(originUrl, n) {
  const url = String(originUrl || '');
  if (/github\.com/i.test(url)) return [`pull/${n}/head`];
  if (/gitlab\.com/i.test(url)) return [`merge-requests/${n}/head`];
  return [`pull/${n}/head`, `merge-requests/${n}/head`];
}

/** Absolute dugite binary, or '' if the embed is missing. Never PATH `git`. */
export function bundledGitPath() {
  try {
    const { gitLocation } = setupEnvironment({});
    return gitLocation && existsSync(gitLocation) ? gitLocation : '';
  } catch {
    return '';
  }
}

function resolveGitRunner() {
  let gitLocation = '';
  let env = {};
  try {
    const setup = setupEnvironment({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    gitLocation = setup.gitLocation;
    env = setup.env;
  } catch { /* setup failed */ }
  if (!gitLocation || !existsSync(gitLocation)) {
    throw new Error('dugite embedded git is missing — SPAWN will not call PATH git');
  }
  return { bin: gitLocation, env, bundled: true };
}

let lastGitBinary = '';
export function gitBinary() { return lastGitBinary; }

/** Dugite bundled git only. Never exec `git` from PATH. */
export function git(args, cwd, { allowFail = false, timeout = GIT_MS } = {}) {
  let bin, env;
  try {
    ({ bin, env } = resolveGitRunner());
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
  lastGitBinary = bin;
  try {
    return execFileSync(bin, ['-c', 'safe.directory=*', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (allowFail) return '';
    const err = new Error((e.stderr || e.message || '').toString().trim() || 'git failed');
    err.code = e.status;
    throw err;
  }
}

export function githubRepoFromOrigin(originUrl) {
  const m = /github\.com[:/]([^/]+)\/([^/.]+)/i.exec(String(originUrl || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function githubPullApiUrl(originUrl, n) {
  const r = githubRepoFromOrigin(originUrl);
  return r ? `https://api.github.com/repos/${r.owner}/${r.repo}/pulls/${n}` : null;
}

export function gitlabProjectFromOrigin(originUrl) {
  const m = /gitlab\.com[:/](.+?)(?:\.git)?$/i.exec(String(originUrl || '').replace(/\/+$/, ''));
  return m ? m[1].replace(/\.git$/i, '') : null;
}

export function gitlabMrApiUrl(originUrl, n) {
  const project = gitlabProjectFromOrigin(originUrl);
  return project
    ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${n}`
    : null;
}

function httpGetJsonSync(url) {
  const src = `
    const r = await fetch(${JSON.stringify(url)}, {
      headers: { 'user-agent': 'openzoo-grokui', accept: 'application/json' },
    });
    if (!r.ok) process.exit(1);
    process.stdout.write(await r.text());
  `;
  const body = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
    timeout: FETCH_MS,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(body);
}

/** GitHub/GitLab API → commit SHA when `git fetch pull/N/head` cannot. */
export function fetchPrHeadShaViaApi(originUrl, n) {
  const gh = githubPullApiUrl(originUrl, n);
  if (gh) {
    try {
      const j = httpGetJsonSync(gh);
      if (j?.head?.sha) return String(j.head.sha);
    } catch { /* */ }
  }
  const gl = gitlabMrApiUrl(originUrl, n);
  if (gl) {
    try {
      const j = httpGetJsonSync(gl);
      if (j?.sha) return String(j.sha);
    } catch { /* */ }
  }
  return '';
}

export function isolatedWorktreesHome(home = homedir()) {
  return path.join(home, '.openzoo', 'grokui-worktrees');
}

export function isGitRepo(dir) {
  if (!dir || !existsSync(dir)) return false;
  return git(['rev-parse', '--is-inside-work-tree'], dir, { allowFail: true }) === 'true';
}

export function mainRepoRoot(dir) {
  if (!isGitRepo(dir)) return null;
  let common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir, { allowFail: true });
  if (!common) {
    const rel = git(['rev-parse', '--git-common-dir'], dir, { allowFail: true });
    common = rel ? path.resolve(dir, rel) : '';
  }
  if (!common) return null;
  if (common.endsWith('.git')) return path.dirname(common);
  return common;
}

export function originUrl(repo) {
  return git(['remote', 'get-url', 'origin'], repo, { allowFail: true });
}

export function freshBaseRef(repo) {
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo, { allowFail: true });
  if (sym) return sym.replace(/^refs\/remotes\//, '');
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(['rev-parse', '--verify', cand], repo, { allowFail: true })) return cand;
  }
  return 'HEAD';
}

function ensureExclude(repo) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo, { allowFail: true })
    || path.join(repo, '.git');
  const exclude = path.join(common, 'info', 'exclude');
  try { mkdirSync(path.dirname(exclude), { recursive: true }); } catch { /* */ }
  let cur = '';
  try { cur = readFileSync(exclude, 'utf8'); } catch { /* */ }
  if (!cur.includes('.openzoo/worktrees')) {
    appendFileSync(exclude, (cur.endsWith('\n') || !cur ? '' : '\n') + '.openzoo/worktrees/\n');
  }
}

function worktreeListed(repo, dest) {
  const list = git(['worktree', 'list', '--porcelain'], repo, { allowFail: true });
  const want = path.resolve(dest);
  for (const block of list.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('worktree '));
    if (line && path.resolve(line.slice(9).trim()) === want) return true;
  }
  return false;
}

function simpleGlobMatch(pattern, rel) {
  const p = String(pattern || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const r = String(rel || '').replace(/\\/g, '/');
  if (!p) return false;
  if (!p.includes('*') && !p.includes('?')) {
    return r === p || r.endsWith('/' + p) || path.basename(r) === p;
  }
  const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(r) || re.test(path.basename(r));
}

/** Claude .worktreeinclude — copy matching gitignored files. Optional, never blocks. */
export function copyWorktreeIncludes(repo, dest) {
  const spec = path.join(repo, '.worktreeinclude');
  if (!existsSync(spec) || !existsSync(dest)) return 0;
  const patterns = readFileSync(spec, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!patterns.length) return 0;
  const ignored = git(['ls-files', '-oi', '--exclude-standard', '-z'], repo, { allowFail: true })
    .split('\0').filter(Boolean);
  let n = 0;
  for (const rel of ignored) {
    if (!patterns.some((p) => simpleGlobMatch(p, rel))) continue;
    const from = path.join(repo, rel);
    const to = path.join(dest, rel);
    try {
      if (!existsSync(from)) continue;
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
      n += 1;
    } catch { /* optional */ }
  }
  return n;
}

export function worktreePath(repo, slug) {
  return path.join(repo, '.openzoo', 'worktrees', slug);
}

export function worktreeBranch(slug) {
  return `worktree-${slug}`;
}

function addWorktree(repo, slug, { pr = null } = {}) {
  const dest = worktreePath(repo, slug);
  const branch = worktreeBranch(slug);
  mkdirSync(path.dirname(dest), { recursive: true });
  ensureExclude(repo);

  if (existsSync(dest) && worktreeListed(repo, dest)) {
    return {
      path: dest, branch, repo, reused: true,
      fetchRef: pr?.n ? fetchSpecsForOrigin(originUrl(repo), pr.n)[0] : '',
    };
  }
  if (existsSync(dest)) {
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* */ }
  }

  let base = freshBaseRef(repo);
  let fetchRef = '';
  if (pr?.n) {
    const origin = originUrl(repo);
    const specs = fetchSpecsForOrigin(origin, pr.n);
    for (const spec of specs) {
      try {
        git(['fetch', '--no-tags', 'origin', spec], repo, { timeout: FETCH_MS });
        if (git(['rev-parse', '--verify', 'FETCH_HEAD'], repo, { allowFail: true })) {
          fetchRef = spec;
          base = 'FETCH_HEAD';
          break;
        }
      } catch { /* next spec */ }
    }
    if (!fetchRef && origin) {
      const sha = fetchPrHeadShaViaApi(origin, pr.n);
      if (sha) {
        try {
          git(['fetch', '--no-tags', 'origin', sha], repo, { timeout: FETCH_MS });
          if (git(['rev-parse', '--verify', sha], repo, { allowFail: true })) {
            fetchRef = specs[0];
            base = sha;
          }
        } catch { /* isolated fallback */ }
      }
    }
  }

  const hasBranch = Boolean(git(['rev-parse', '--verify', `refs/heads/${branch}`], repo, { allowFail: true }));
  try {
    if (hasBranch) git(['worktree', 'add', dest, branch], repo);
    else git(['worktree', 'add', '-b', branch, dest, base], repo);
  } catch (e) {
    if (!existsSync(dest)) throw e;
  }
  try { copyWorktreeIncludes(repo, dest); } catch { /* optional */ }
  return {
    path: dest, branch, repo, reused: hasBranch, baseRef: base,
    ...(fetchRef ? { fetchRef } : {}),
    ...(pr?.n ? { pr: pr.n } : {}),
  };
}

function isolatedChildDir(parentDir, slug) {
  let dest = path.join(isolatedWorktreesHome(), slug);
  const parent = path.resolve(parentDir);
  if (dest === parent || dest.startsWith(parent + path.sep)) {
    dest = path.join(homedir(), '.openzoo', 'grokui-worktrees-out', slug);
  }
  if (dest === parent) throw new Error('refusing to isolate a child into the parent cwd');
  mkdirSync(dest, { recursive: true });
  return { path: dest, branch: null, kind: 'isolated' };
}

/**
 * Isolated cwd for a SPAWNed grokui thread (same Node process; shell cwd = t.dir).
 * Git parent → <repo>/.openzoo/worktrees/<slug> on worktree-<slug>.
 * Non-git → ~/.openzoo/grokui-worktrees/<slug>, never the parent dir.
 */
export function prepareChildDir(parent, name, spec) {
  const parentDir = path.resolve(parent?.dir || process.env.OZ_WORKSPACE_DIR
    || path.join(homedir(), '.openzoo', 'grokui-workspace'));
  const pr = extractPrFromSpawn(name, spec);
  const slug = pr && parsePrRef(name) ? `pr-${pr.n}` : agentSlug(name);
  const repo = mainRepoRoot(parentDir);
  if (repo) {
    try {
      const ws = addWorktree(repo, slug, { pr });
      return {
        path: ws.path,
        branch: ws.branch,
        parentDir,
        kind: 'worktree',
        repo,
        fetchRef: ws.fetchRef || '',
        baseRef: ws.baseRef,
      };
    } catch { /* fall back to isolated, still not parent cwd */ }
  }
  return { ...isolatedChildDir(parentDir, slug), parentDir };
}

export function worktreeHasWork(wt) {
  if (!wt?.path || !existsSync(wt.path)) return false;
  if (wt.kind === 'isolated' || !wt.branch) {
    try { return readdirSync(wt.path).length > 0; } catch { return false; }
  }
  if (git(['status', '--porcelain'], wt.path, { allowFail: true })) return true;
  const base = wt.baseRef && wt.baseRef !== 'FETCH_HEAD' && wt.baseRef !== 'HEAD'
    ? wt.baseRef
    : (wt.repo ? freshBaseRef(wt.repo) : 'HEAD');
  if (Number(git(['rev-list', '--count', `${base}..HEAD`], wt.path, { allowFail: true })) > 0) return true;
  const unpushed = git(['rev-list', '--count', '@{upstream}..HEAD'], wt.path, { allowFail: true });
  return Boolean(unpushed && Number(unpushed) > 0);
}

export function lockWorktree(wtOrThread) {
  const wt = wtOrThread?.worktree || wtOrThread;
  if (!wt?.path || !wt.branch || !existsSync(wt.path)) return false;
  git(['worktree', 'lock', '--reason', 'openzoo spawn', wt.path], wt.repo || wt.path, { allowFail: true });
  wt.locked = true;
  return true;
}

export function unlockWorktree(wtOrThread) {
  const wt = wtOrThread?.worktree || wtOrThread;
  if (!wt?.path || !wt.branch) return false;
  git(['worktree', 'unlock', wt.path], wt.repo || wt.path, { allowFail: true });
  wt.locked = false;
  return true;
}

/** Clean worktree → remove + delete the branch we created. Dirty → keep. */
export function finishChildDir(wtOrThread) {
  const thread = wtOrThread && wtOrThread.worktree ? wtOrThread : null;
  const wt = thread?.worktree || wtOrThread;
  if (!wt?.path) return { skipped: true };
  unlockWorktree(wt);
  if (worktreeHasWork(wt)) return { kept: true, path: wt.path, branch: wt.branch };
  if (wt.kind === 'worktree' && wt.repo && wt.branch) {
    git(['worktree', 'remove', '--force', wt.path], wt.repo, { allowFail: true });
    git(['branch', '-D', wt.branch], wt.repo, { allowFail: true });
  }
  try { if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true }); } catch { /* */ }
  if (thread) delete thread.worktree;
  return { removed: true, path: wt.path, branch: wt.branch };
}

export function isWorktreeLocked(repo, dest) {
  const list = git(['worktree', 'list', '--porcelain'], repo, { allowFail: true });
  const want = path.resolve(dest);
  let current = '';
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) current = path.resolve(line.slice(9).trim());
    if ((line === 'locked' || line.startsWith('locked ')) && current === want) return true;
  }
  return false;
}
