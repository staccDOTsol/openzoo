/**
 * Stop paid Bash/grep loops (Claude Code via OpenZoo) and grokui RUN retries.
 *
 * Identical or near-identical Bash/grep bodies in one thread must not be
 * paid/executed more than twice. After a successful compile artifact
 * (e.g. target/.../release/fate.so), further greps for declare_id stop.
 * A bash syntax error or "command not found" is done-for-this-hop.
 */

const DIRECTIVE_AS_BASH = /^(?:WRITE|READ|EDIT|MULTIEDIT|NOTEBOOK|GLOB|LS|LIST|DIR|FIND|GREP|SERVE|FETCH|MCP|SPAWN|SEND|PING|PEEK|DONE|TODO):\s*\S/i;
const GREP_HEAD = /^(?:\/usr\/bin\/|\/bin\/)?(?:grep|egrep|fgrep|rg|ripgrep)\b/;
const ARTIFACT_RE = /(?:^|[\\/\s])(?:fate\.so|[\w.-]+\.so)\b|target\/[^\s]*\/release\/[\w.-]+\.so/i;
const GREP_IDS_RE = /\b(?:declare_id|declare_program_id|program[_-]?id)\b/i;

export function normalizeBashBody(cmd) {
  return String(cmd || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
}

export function grepFingerprint(cmd) {
  const s = normalizeBashBody(cmd);
  if (!s) return '';
  if (GREP_HEAD.test(s) || GREP_IDS_RE.test(s)) {
    const needle = (s.match(/declare_id|declare_program_id|program[_-]?id/i)
      || s.match(/-e\s+(\S+)/)
      || s.match(/['"]([^'"]{2,})['"]/)
      || [s])[0];
    return `grep:${String(needle).toLowerCase()}`;
  }
  return s;
}

export function nearIdenticalBash(a, b) {
  const ka = grepFingerprint(a);
  const kb = grepFingerprint(b);
  return Boolean(ka && kb && ka === kb);
}

export function looksLikeDirectiveAsBash(command) {
  return DIRECTIVE_AS_BASH.test(String(command || '').trim());
}

/** Ask-mode `WRITE: path | content` or a bare `WRITE:path` that Claude
 *  Code bash'd after a NUDGE. Never a shell command. */
export function parseWriteDirective(text) {
  const s = String(text || '');
  const withBody = /^[ \t>*-]*WRITE:\s*([^|\n]+)\|([\s\S]+)/im.exec(s);
  if (withBody) {
    const filePath = withBody[1].trim();
    if (filePath) return { path: filePath, content: withBody[2].replace(/^\n/, '') };
  }
  const bare = /^[ \t>*-]*WRITE:\s*(\S+)/im.exec(s);
  if (bare && bare[1].trim()) return { path: bare[1].trim(), content: null };
  return null;
}

export function writeDirectiveStopText(write) {
  const filePath = write?.path || 'file';
  return `refused: WRITE:${filePath} is the Ask-mode harness, not bash. `
    + 'Use the Write tool with file_path and contents. Do not exec WRITE: as a shell command.';
}

export function isFailedExecOutput(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/command not found/i.test(s)) return true;
  if (/syntax error/i.test(s)) return true;
  if (/SyntaxError:/i.test(s)) return true;
  if (/\(exit 127\)/.test(s)) return true;
  return false;
}

export function looksLikeGrepIds(cmd) {
  const s = String(cmd || '');
  return GREP_HEAD.test(normalizeBashBody(s)) && GREP_IDS_RE.test(s);
}

export function hasCompileArtifact(textOrMsgs) {
  if (typeof textOrMsgs === 'string') return ARTIFACT_RE.test(textOrMsgs);
  if (!Array.isArray(textOrMsgs)) return false;
  for (const m of textOrMsgs) {
    const t = typeof m?.content === 'string' ? m.content
      : Array.isArray(m?.content) ? m.content.map((b) => b?.text || b?.content || '').join('\n')
        : '';
    if (ARTIFACT_RE.test(t)) return true;
    if (m?.role === 'tool' && ARTIFACT_RE.test(String(m.content || ''))) return true;
  }
  return false;
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function msgText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((b) => {
      if (typeof b === 'string') return b;
      return b?.text || b?.content || (typeof b?.input?.command === 'string' ? b.input.command : '');
    }).join('\n');
  }
  return '';
}

export function extractBashFromText(text) {
  const s = String(text || '');
  const fence = /```(?:bash|sh|zsh)?\n([\s\S]*?)```/.exec(s);
  if (fence) return fence[1].trim();
  const json = /"command"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(s);
  if (json) {
    try { return JSON.parse(`"${json[1]}"`); } catch { /* keep */ }
  }
  const line = /^(?:[ \t]*)((?:grep|egrep|fgrep|rg|ripgrep|find|ls)\b[^\n]+)$/m.exec(s);
  if (line) return line[1].trim();
  return '';
}

export function extractLastBashCommand(messages) {
  if (!Array.isArray(messages)) return extractBashFromText(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const calls = [
      ...(Array.isArray(m.tool_calls) ? m.tool_calls : []),
      ...(m.function_call ? [m.function_call] : []),
    ];
    for (let j = calls.length - 1; j >= 0; j--) {
      const c = calls[j];
      const name = c?.function?.name || c?.name || '';
      if (!/^bash$/i.test(name) && !/^grep$/i.test(name)) continue;
      const args = parseToolArgs(c?.function?.arguments ?? c?.arguments);
      if (typeof args.command === 'string' && args.command.trim()) return args.command;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type === 'tool_use' && /^(bash|grep)$/i.test(b.name || '') && typeof b.input?.command === 'string') {
        return b.input.command;
      }
    }
    const fromText = extractBashFromText(msgText(m));
    if (fromText) return fromText;
  }
  return '';
}

export function countNearIdenticalBashRuns(messages, command) {
  if (!Array.isArray(messages) || !command) return 0;
  const want = grepFingerprint(command);
  if (!want) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m) continue;
    const calls = [
      ...(Array.isArray(m.tool_calls) ? m.tool_calls : []),
      ...(m.function_call ? [m.function_call] : []),
    ];
    for (const c of calls) {
      const name = c?.function?.name || c?.name || '';
      if (!/^bash$/i.test(name) && !/^grep$/i.test(name)) continue;
      const args = parseToolArgs(c?.function?.arguments ?? c?.arguments);
      if (grepFingerprint(args.command) === want) n += 1;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b?.type === 'tool_use' && /^(bash|grep)$/i.test(b.name || '')) {
        if (grepFingerprint(b.input?.command) === want) n += 1;
      }
    }
  }
  return n;
}

export function extractLastBashStdout(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'tool' && typeof m.content === 'string' && m.content.trim()) return m.content;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type === 'tool_result' && typeof b.content === 'string' && b.content.trim()) return b.content;
    }
  }
  return '';
}

export function bashStopText(stdout, reason = 'repeat') {
  const body = stdout && String(stdout).trim() ? String(stdout).trim() : '(no output)';
  const why = reason === 'compile-artifact'
    ? 'Auto stopped — compile artifact already exists; not grepping the same ids again.'
    : 'Auto stopped — the same Bash/grep ran twice. Not retrying.';
  return `${body}\n${why}`;
}

export function createBashLoopTracker({ maxRuns = 2 } = {}) {
  const sessions = new Map();
  function slot(sid) {
    const key = String(sid || '__default__');
    let s = sessions.get(key);
    if (!s) {
      s = { cmds: new Map(), artifact: false };
      sessions.set(key, s);
    }
    return s;
  }
  function rememberStdout(sid, command, stdout) {
    const s = slot(sid);
    const fp = grepFingerprint(command);
    if (!fp) return;
    const prev = s.cmds.get(fp) || { runs: 0, stdout: '' };
    if (stdout != null && String(stdout).trim()) prev.stdout = String(stdout);
    s.cmds.set(fp, prev);
    if (hasCompileArtifact(String(stdout || ''))) s.artifact = true;
  }
  function markArtifact(sid) {
    slot(sid).artifact = true;
  }
  function note(sid, command, stdout) {
    const s = slot(sid);
    const fp = grepFingerprint(command);
    if (!fp) return 0;
    const prev = s.cmds.get(fp) || { runs: 0, stdout: '' };
    prev.runs += 1;
    if (stdout != null && String(stdout).trim()) prev.stdout = String(stdout);
    s.cmds.set(fp, prev);
    if (hasCompileArtifact(String(stdout || '')) || ARTIFACT_RE.test(String(command || ''))) s.artifact = true;
    return prev.runs;
  }
  function decide(sid, command, { messages, stdout } = {}) {
    const cmd = String(command || '').trim();
    if (!cmd) return { stop: false, runs: 0, stdout: '', reason: '' };
    const write = parseWriteDirective(cmd);
    if (write || looksLikeDirectiveAsBash(cmd)) {
      return {
        stop: true, runs: 0, stdout: '', reason: 'ask-directive', write,
        text: writeDirectiveStopText(write),
      };
    }
    const s = slot(sid);
    if (hasCompileArtifact(messages) || hasCompileArtifact(stdout) || s.artifact) s.artifact = true;
    const fp = grepFingerprint(cmd);
    const rec = s.cmds.get(fp);
    const hist = countNearIdenticalBashRuns(messages, cmd);
    const runs = Math.max(rec?.runs || 0, hist);
    const prevOut = rec?.stdout || extractLastBashStdout(messages) || '';
    if (s.artifact && looksLikeGrepIds(cmd)) {
      return { stop: true, runs, stdout: prevOut, reason: 'compile-artifact', text: bashStopText(prevOut, 'compile-artifact') };
    }
    if (runs >= maxRuns) {
      return { stop: true, runs, stdout: prevOut, reason: 'repeat', text: bashStopText(prevOut, 'repeat') };
    }
    return { stop: false, runs, stdout: prevOut, reason: '' };
  }
  function reset(sid) {
    if (sid == null) sessions.clear();
    else sessions.delete(String(sid));
  }
  return { note, rememberStdout, markArtifact, decide, reset, slot };
}

export const bashLoops = createBashLoopTracker();
