/**
 * OCC /goal — one slash. While a goal is set, AskUser is a no-op and the
 * loop keeps using tools until the job is done. Do not invent a new goal.
 */

export const ASKUSER_GOAL_RESULT =
  'A goal is already set. Do not ask the user. Keep using tools until the goal is done.';

export const GOAL_CONTINUATION =
  'A goal is already set. Do not ask what they would like to do. Keep using tools until the goal is done.';

export function isGoalActive(state) {
  return Boolean(state && typeof state.goal === 'string' && state.goal.trim());
}

export function setGoal(state, text) {
  if (!state || typeof state !== 'object') return state;
  const t = String(text || '').replace(/^\/goal\b/i, '').trim();
  if (t) state.goal = t;
  return state;
}

export function goalUserText(state) {
  return isGoalActive(state) ? String(state.goal).trim() : '';
}

export function shouldSkipAskUser(block, state) {
  return Boolean(block && block.name === 'AskUser' && isGoalActive(state));
}

/** Last user turn with real string/text (skip tool_result-only). */
export function lastStringUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const t = rawUserText(m);
    if (t) return t;
  }
  return '';
}

export function rawUserText(m) {
  const c = m?.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c.map((b) => {
    if (typeof b === 'string') return b;
    if (b && (b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string') return b.text;
    if (typeof b?.text === 'string' && !b.type) return b.text;
    return '';
  }).filter((s) => s && s.trim()).join('\n').trim();
}

/** Prompt written into the loop when the user types `/goal <job>`. */
export function goalPrompt(job) {
  const t = String(job || '').replace(/^\/goal\b/i, '').trim();
  if (!t) return '';
  return `${t}\n\nDo not ask what they would like to do. Keep using tools until the goal is done.`;
}

function toolUseIdsIn(messages) {
  const ids = new Set();
  for (const m of messages || []) {
    const blocks = Array.isArray(m?.content) ? m.content : [];
    for (const b of blocks) {
      if (b && (b.type === 'tool_use' || b.type === 'function') && b.id) ids.add(String(b.id));
    }
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) ids.add(String(tc.id));
    }
  }
  return ids;
}

function cloneMessage(m) {
  if (!m || typeof m !== 'object') return m;
  if (Array.isArray(m.content)) {
    return { ...m, content: m.content.map((b) => (b && typeof b === 'object' ? { ...b } : b)) };
  }
  return { ...m };
}

function hasRealUserText(messages) {
  for (const m of messages || []) {
    if (m?.role !== 'user') continue;
    if (rawUserText(m)) return true;
  }
  return false;
}

/**
 * Drop orphan tool_result blocks (no preceding assistant tool_use id).
 * Ensure at least one user message with real string/text — inject state.goal
 * or the last string user text. Do not invent a new goal.
 */
export function sanitizePoisonedHistory(messages, state = {}) {
  const src = Array.isArray(messages) ? messages : [];
  const ids = toolUseIdsIn(src);
  const out = [];
  for (const raw of src) {
    const m = cloneMessage(raw);
    if (Array.isArray(m.content)) {
      m.content = m.content.filter((b) => {
        if (!b || b.type !== 'tool_result') return true;
        const id = b.tool_use_id || b.tool_useId || b.id;
        return id && ids.has(String(id));
      });
      if (m.role === 'user' && m.content.length === 0) continue;
    }
    out.push(m);
  }
  const inject = String(state.goal || '').trim() || lastStringUserText(src);
  if (inject) {
    const last = out[out.length - 1];
    const onlyTools = last
      && last.role === 'user'
      && Array.isArray(last.content)
      && last.content.length > 0
      && last.content.every((b) => b && b.type === 'tool_result');
    if (onlyTools) {
      last.content = [{ type: 'text', text: inject }, ...last.content];
    } else if (!hasRealUserText(out)) {
      out.push({ role: 'user', content: inject });
    }
  }
  return out;
}
