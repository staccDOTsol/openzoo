import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentSlug, parsePrRef, extractPrFromSpawn, fetchSpecsForOrigin,
  git, gitBinary, bundledGitPath, prepareChildDir, finishChildDir,
  isolatedWorktreesHome, githubPullApiUrl, gitlabMrApiUrl,
} from '../lib/worktree.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function runChild(script, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, OZ_AGENT_PORTS: '0', ...envExtra },
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('worktree child timed out: ' + buf));
    }, 30000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error('worktree child exited ' + code + ': ' + buf));
      else resolve(buf);
    });
  });
}

function initRepo(dir, { branch = 'main' } = {}) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-b', branch], dir);
  git(['config', 'user.email', 'wt@test'], dir);
  git(['config', 'user.name', 'wt'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

function commitAll(dir, msg) {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
}

test('git() uses dugite bundled binary, not PATH git', () => {
  const bundled = bundledGitPath();
  assert.ok(bundled, 'dugite embedded git must be installed');
  assert.match(bundled, /dugite/);
  assert.ok(existsSync(bundled));
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-bin-'));
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    git(['--version'], dir);
    assert.equal(gitBinary(), bundled);
    assert.match(gitBinary(), /dugite/);
    assert.ok(path.isAbsolute(gitBinary()));
    assert.notEqual(gitBinary(), 'git');
  } finally {
    process.env.PATH = prev;
  }
});

test('GitHub/GitLab API URLs for PR heads when fetch ref is remote', () => {
  assert.equal(
    githubPullApiUrl('https://github.com/example/repo.git', 7),
    'https://api.github.com/repos/example/repo/pulls/7',
  );
  assert.equal(
    githubPullApiUrl('git@github.com:example/repo.git', 7),
    'https://api.github.com/repos/example/repo/pulls/7',
  );
  assert.equal(githubPullApiUrl('/tmp/local.git', 7), null);
  assert.equal(
    gitlabMrApiUrl('https://gitlab.com/group/proj.git', 3),
    'https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3',
  );
});

test('prepareChildDir works with an empty PATH (Finder has no ~/.zshrc git)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-nopath-'));
  const repo = path.join(dir, 'repo');
  const prev = process.env.PATH;
  process.env.PATH = '/no/such/git/bin';
  try {
    initRepo(repo);
    writeFileSync(path.join(repo, 'marker.txt'), 'parent');
    commitAll(repo, 'init');
    const a = prepareChildDir({ dir: repo }, 'alice', 'do a');
    assert.match(a.path, /\.openzoo\/worktrees\/alice$/);
    assert.equal(a.branch, 'worktree-alice');
    assert.match(gitBinary(), /dugite/);
  } finally {
    process.env.PATH = prev;
  }
});

test('parsePrRef and fetchSpecsForOrigin match Claude --worktree', () => {
  assert.equal(agentSlug('Game Builder'), 'game-builder');
  assert.equal(agentSlug('#42'), 'pr-42');
  assert.deepEqual(parsePrRef('#123'), { n: 123 });
  assert.equal(parsePrRef('https://github.com/org/repo/pull/99').n, 99);
  assert.equal(parsePrRef('https://github.com/org/repo/pull/99/files').n, 99);
  assert.equal(parsePrRef('https://gitlab.com/g/r/-/merge_requests/7').n, 7);
  assert.equal(extractPrFromSpawn('reviewer', '#8 review this').n, 8);
  assert.equal(extractPrFromSpawn('helper', 'https://github.com/a/b/pull/3 | look').n, 3);
  assert.deepEqual(fetchSpecsForOrigin('https://github.com/a/b.git', 4), ['pull/4/head']);
  assert.deepEqual(fetchSpecsForOrigin('https://gitlab.com/a/b.git', 4), ['merge-requests/4/head']);
  assert.deepEqual(fetchSpecsForOrigin('/tmp/local.git', 4), ['pull/4/head', 'merge-requests/4/head']);
});

test('prepareChildDir: two git worktrees, parent files unchanged', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-git-'));
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  writeFileSync(path.join(repo, 'marker.txt'), 'parent');
  commitAll(repo, 'init');
  const parent = { dir: repo };
  const a = prepareChildDir(parent, 'alice', 'write kid a');
  const b = prepareChildDir(parent, 'bob', 'write kid b');
  assert.notEqual(a.path, repo);
  assert.notEqual(b.path, repo);
  assert.notEqual(a.path, b.path);
  assert.match(a.path, /\.openzoo\/worktrees\/alice$/);
  assert.match(b.path, /\.openzoo\/worktrees\/bob$/);
  assert.equal(a.branch, 'worktree-alice');
  assert.equal(b.branch, 'worktree-bob');
  writeFileSync(path.join(a.path, 'kid-a.txt'), 'from-alice');
  writeFileSync(path.join(b.path, 'kid-b.txt'), 'from-bob');
  writeFileSync(path.join(a.path, 'marker.txt'), 'alice-overwrote');
  assert.equal(readFileSync(path.join(repo, 'marker.txt'), 'utf8'), 'parent');
  assert.equal(existsSync(path.join(repo, 'kid-a.txt')), false);
  assert.equal(existsSync(path.join(repo, 'kid-b.txt')), false);
  const branches = git(['branch', '--list'], repo);
  assert.match(branches, /worktree-alice/);
  assert.match(branches, /worktree-bob/);
});

test('prepareChildDir: #N / GitHub PR URL fetches pull/N/head when origin is github', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-pr-'));
  const repo = path.join(dir, 'repo');
  const bare = path.join(dir, 'origin.git');
  initRepo(repo);
  writeFileSync(path.join(repo, 'base.txt'), 'base');
  commitAll(repo, 'base');
  git(['clone', '--bare', repo, bare], dir);
  git(['checkout', '-b', 'pr-branch'], repo);
  writeFileSync(path.join(repo, 'pr-only.txt'), 'from-pr');
  commitAll(repo, 'pr commit');
  const prSha = git(['rev-parse', 'HEAD'], repo);
  git(['push', bare, 'HEAD:refs/pull/7/head'], repo);
  git(['checkout', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], repo);
  git(['config', `url.${bare}.insteadOf`, 'https://github.com/example/repo.git'], repo);
  git(['fetch', 'origin'], repo);
  git(['remote', 'set-head', 'origin', 'main'], repo);

  const hash = prepareChildDir({ dir: repo }, 'reviewer', '#7');
  assert.equal(hash.fetchRef, 'pull/7/head');
  assert.equal(git(['rev-parse', 'HEAD'], hash.path), prSha);
  assert.equal(readFileSync(path.join(hash.path, 'pr-only.txt'), 'utf8'), 'from-pr');
  assert.equal(existsSync(path.join(repo, 'pr-only.txt')), false);

  const url = prepareChildDir({ dir: repo }, 'other', 'https://github.com/example/repo/pull/7');
  assert.equal(url.fetchRef, 'pull/7/head');
  assert.equal(git(['rev-parse', 'HEAD'], url.path), prSha);
});

test('prepareChildDir: non-git parent → isolated dir outside parent files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-nongit-'));
  const parentDir = path.join(dir, 'testingcluade');
  mkdirSync(parentDir);
  writeFileSync(path.join(parentDir, 'only-parent.txt'), 'stay');
  const prevHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const kid = prepareChildDir({ dir: parentDir }, 'kid', 'go');
    assert.notEqual(path.resolve(kid.path), path.resolve(parentDir));
    assert.equal(kid.path.startsWith(path.resolve(parentDir) + path.sep), false,
      'isolated sibling must sit outside parent files, not testingcluade/testingcluade');
    assert.equal(kid.path, path.join(isolatedWorktreesHome(dir), 'kid'));
    writeFileSync(path.join(kid.path, 'kid.txt'), 'child');
    assert.equal(existsSync(path.join(parentDir, 'kid.txt')), false);
    assert.equal(readFileSync(path.join(parentDir, 'only-parent.txt'), 'utf8'), 'stay');
  } finally {
    process.env.HOME = prevHome;
  }
});

test('finishChildDir: clean removed, dirty kept', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-clean-'));
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  commitAll(repo, 'init');
  const clean = prepareChildDir({ dir: repo }, 'clean', 'noop');
  const dirty = prepareChildDir({ dir: repo }, 'dirty', 'edit');
  writeFileSync(path.join(dirty.path, 'new.txt'), 'work');
  const gone = finishChildDir({ ...clean, kind: 'worktree' });
  const kept = finishChildDir({ ...dirty, kind: 'worktree' });
  assert.equal(gone.removed, true);
  assert.equal(existsSync(clean.path), false);
  assert.equal(kept.kept, true);
  assert.equal(existsSync(dirty.path), true);
  const branches = git(['branch', '--list'], repo);
  assert.doesNotMatch(branches, /worktree-clean/);
  assert.match(branches, /worktree-dirty/);
});

test('SPAWN two agents in a git repo get distinct worktree cwds', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-spawn-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 22000 + Math.floor(Math.random() * 2000);
  const repo = path.join(dir, 'repo');
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(path.join(dir, 'ws'))};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
    const path = await import('node:path');
    const { git, prepareChildDir } = await import(${JSON.stringify(path.join(root, 'lib/worktree.mjs'))});
    const repo = ${JSON.stringify(repo)};
    mkdirSync(repo, { recursive: true });
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 'wt@test'], repo);
    git(['config', 'user.name', 'wt'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    writeFileSync(path.join(repo, 'marker.txt'), 'parent');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'init'], repo);

    const { tryDirective, newThread, findByName, setRunTurnForTest, childKickoff } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});
    setRunTurnForTest(() => Promise.resolve());
    const parent = newThread('boss', null);
    parent.dir = repo;
    const ack = await tryDirective('SPAWN: alice | do a\\nSPAWN: bob | do b', parent.id);
    assert.match(ack, /alice/);
    assert.match(ack, /bob/);
    const alice = findByName('alice');
    const bob = findByName('bob');
    assert.ok(alice && bob);
    assert.notEqual(alice.dir, parent.dir);
    assert.notEqual(bob.dir, parent.dir);
    assert.notEqual(alice.dir, bob.dir);
    assert.match(alice.dir, /\\.openzoo\\/worktrees\\/alice$/);
    assert.match(bob.dir, /\\.openzoo\\/worktrees\\/bob$/);
    assert.equal(alice.worktree.branch, 'worktree-alice');
    assert.equal(bob.worktree.branch, 'worktree-bob');
    writeFileSync(path.join(alice.dir, 'kid-a.txt'), 'from-alice');
    writeFileSync(path.join(alice.dir, 'marker.txt'), 'alice');
    assert.equal(readFileSync(path.join(repo, 'marker.txt'), 'utf8'), 'parent');
    assert.equal(existsSync(path.join(repo, 'kid-a.txt')), false);
    const brief = childKickoff(parent, 'alice', 'do a');
    assert.match(brief, new RegExp(alice.dir.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')));
    assert.match(brief, /worktree-alice/);
    assert.doesNotMatch(brief, /type  \\/dir/);
    const again = await tryDirective('SPAWN: alice | keep going', parent.id);
    assert.match(again, /already exists/);
    assert.match(again, /woke it to keep working/);
    console.log(JSON.stringify({ ok: true, alice: alice.dir, bob: bob.dir }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed JSON: ' + out);
  assert.equal(JSON.parse(line).ok, true);
});

test('SPAWN non-git parent does not dump kids in parent cwd', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-wt-spawn-ng-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23000 + Math.floor(Math.random() * 2000);
  const parentDir = path.join(dir, 'testingcluade');
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(path.join(dir, 'ws'))};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const path = await import('node:path');
    mkdirSync(${JSON.stringify(parentDir)}, { recursive: true });
    writeFileSync(path.join(${JSON.stringify(parentDir)}, 'only-parent.txt'), 'stay');
    const { tryDirective, newThread, findByName, setRunTurnForTest, finishChildDir } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});
    setRunTurnForTest(() => Promise.resolve());
    const parent = newThread('boss', null);
    parent.dir = ${JSON.stringify(parentDir)};
    await tryDirective('SPAWN: kid | go', parent.id);
    const kid = findByName('kid');
    assert.ok(kid);
    assert.notEqual(path.resolve(kid.dir), path.resolve(${JSON.stringify(parentDir)}));
    assert.equal(kid.dir.startsWith(path.resolve(${JSON.stringify(parentDir)}) + path.sep), false);
    assert.match(kid.dir, /\\.openzoo\\/grokui-worktrees\\/kid$/);
    writeFileSync(path.join(kid.dir, 'kid.txt'), 'child');
    assert.equal(existsSync(path.join(${JSON.stringify(parentDir)}, 'kid.txt')), false);
    const clean = await tryDirective('DONE:', kid.id);
    assert.match(clean, /removed|Done/);
    console.log(JSON.stringify({ ok: true, dir: kid.dir }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed JSON: ' + out);
  assert.equal(JSON.parse(line).ok, true);
});
