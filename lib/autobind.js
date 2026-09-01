/**
 * AUTO-BIND THE WORKING DIRECTORY.
 *
 * WHY THIS EXISTS, measured: a Claude Code session through the proxy reported
 * `spilled 0/12 calls` and `0.67x vs direct` — i.e. it cost MORE than buying
 * the same calls direct. That is not a pricing bug on its own. leCore only
 * earns its markup when it removes context from the upstream request, and it
 * can only remove context that was BOUND. Nothing was ever bound, so every call
 * paid a multiple for a service that did no work.
 *
 * `bindPath()` and `collectFiles()` already existed. Nothing called them.
 * `openzoo bind ./x` was a thing you had to know about and remember, which
 * means in practice it never happened and the headline number stayed below 1.
 *
 * SO: bind the cwd on launch, in the background, and attach the resulting
 * context to every forwarded call.
 *
 * NEVER $HOME. Binding a home directory means walking ~, dotfiles, caches,
 * SSH keys and browser profiles into a corpus that leaves the machine. The
 * home check is not a performance guard, it is the safety one — same for /, and
 * for anywhere that is not actually a project.
 *
 * NON-BLOCKING BY CONSTRUCTION. The agent must start instantly; a bind of a
 * large repo takes seconds to minutes. So this returns immediately, the bind
 * runs in the background, and calls made before it lands simply go unbound —
 * exactly what happens today. Nothing waits, nothing fails closed.
 */
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Set once the background bind lands. Read by the proxy on every forward. */
let contextId = null;
let state = 'idle';   // idle | binding | ready | skipped | failed
let detail = '';

export function autoContext() { return contextId; }
export function autoBindState() { return { state, contextId, detail }; }

/**
 * Directories that must never be walked into a corpus.
 *
 * $HOME is the important one — see the module comment. The rest are the places
 * where "bind the cwd" would mean "upload the machine".
 */
function refuseReason(dir) {
  const home = os.homedir();
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(home)) return 'cwd is $HOME';
  if (resolved === path.parse(resolved).root) return 'cwd is the filesystem root';
  if (resolved === '/tmp' || resolved === os.tmpdir()) return 'cwd is a temp dir';
  // A project has SOMETHING that marks it. Without one of these, "the current
  // directory" is just wherever the shell happened to be, and binding it is a
  // surprise rather than a feature.
  const marks = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
    'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle', 'CMakeLists.txt',
    'composer.json', 'mix.exs', 'Makefile', 'CLAUDE.md', 'AGENTS.md'];
  if (!marks.some((m) => existsSync(path.join(resolved, m)))) {
    return 'no project marker (.git, package.json, …)';
  }
  return null;
}

/**
 * Kick off a background bind of `dir`. Returns immediately.
 *
 * `log` is the caller's own writer so this never owns stdout — during a Claude
 * Code session stdout belongs to the TUI, and a stray line corrupts it.
 */
export function startAutoBind(dir, { log = () => {} } = {}) {
  if (process.env.OPENZOO_NO_AUTOBIND === '1') {
    state = 'skipped'; detail = 'OPENZOO_NO_AUTOBIND=1';
    return;
  }
  let target;
  try {
    target = path.resolve(dir || process.cwd());
    if (!statSync(target).isDirectory()) { state = 'skipped'; detail = 'not a directory'; return; }
  } catch { state = 'skipped'; detail = 'unreadable cwd'; return; }

  const refuse = refuseReason(target);
  if (refuse) { state = 'skipped'; detail = refuse; return; }

  state = 'binding';
  detail = target;

  // Deliberately NOT awaited. See the module comment.
  (async () => {
    try {
      const { bindPath } = await import('./bindpath.js');
      const res = await bindPath(target, {});
      const id = res?.contextId || res?.context_id || null;
      if (id) {
        contextId = id;
        state = 'ready';
        log(`auto-bound ${path.basename(target)} -> ${id}`);
      } else {
        state = 'failed';
        detail = 'bind returned no context id';
      }
    } catch (err) {
      // A failed bind must never take the session with it. Unbound calls are
      // the status quo, not an outage.
      state = 'failed';
      detail = err?.message || String(err);
      log(`auto-bind failed: ${detail}`);
    }
  })();
}
