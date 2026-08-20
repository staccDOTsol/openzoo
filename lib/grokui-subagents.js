/**
 * Claude Code Task / Agent tools → grokui sidebar rows.
 *
 * Orange Auto's PTY emits Task (and Agent) the same way Write/Bash land as
 * folded tool events. Those are real subagents — including nested ones — and
 * must become the same sidebar threads SPAWN: already creates, not a canvas
 * dump of tool JSON or TUI chrome.
 */

const SUBAGENT_TOOL = /^(task|agent|taskcreate|spawn_agent|subagent)$/i;

export function isClaudeSubagentTool(name) {
  return SUBAGENT_TOOL.test(String(name || '').trim());
}

function titleish(raw) {
  return String(raw || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function claudeSubagentSpec(name, input) {
  const inp = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const type = titleish(inp.subagent_type || inp.agent_type || inp.type || '');
  const desc = titleish(inp.description || inp.name || inp.title || '');
  const task = String(inp.prompt || inp.task || inp.instruction || inp.query || inp.message || '').trim();
  let pretty = desc || type || titleish(name) || 'Subagent';
  if (/^(task|agent|subagent)$/i.test(pretty) && task) {
    pretty = titleish(task.split(/\s+/).slice(0, 4).join(' ')) || pretty;
  }
  pretty = pretty.slice(0, 48) || 'Subagent';
  return { name: pretty, task: task || pretty };
}

export function tuiSubagentInput(rest) {
  const description = String(rest || '').trim();
  return { description, prompt: description };
}

/**
 * Compact hop line for the live status / empty-PTY fallback.
 * One new child: "Spawned Name." One existing: "Messaged Name."
 * Several: "Messaged N Bots" — never a RUN/READ/Task JSON dump.
 */
export function claudeSubagentHopText(hops) {
  const unique = [];
  const seen = new Set();
  for (const hop of hops || []) {
    const child = hop?.child;
    if (!child?.id || seen.has(child.id)) continue;
    seen.add(child.id);
    unique.push(hop);
  }
  if (!unique.length) return '';
  if (unique.length === 1) {
    const name = unique[0].child.name || 'subagent';
    return unique[0].fresh ? `Spawned ${name}.` : `Messaged ${name}.`;
  }
  return `Messaged ${unique.length} Bots`;
}
