import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASKUSER_GOAL_RESULT,
  goalPrompt,
  isGoalActive,
  lastStringUserText,
  sanitizePoisonedHistory,
  setGoal,
  shouldSkipAskUser,
} from '../vendor/openzoo-claude/v2/src/core/goal.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('OCC overlay files parse', () => {
  for (const rel of [
    'vendor/openzoo-claude/v2/src/core/agent-loop.mjs',
    'vendor/openzoo-claude/v2/src/core/goal.mjs',
    'vendor/openzoo-claude/v2/src/ui/commands.mjs',
    'vendor/openzoo-claude/v2/src/ui/app.mjs',
    'vendor/openzoo-claude/v2/src/ui/repl.mjs',
  ]) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, rel)], { encoding: 'utf8' });
    assert.equal(r.status, 0, rel + '\n' + (r.stderr || r.stdout));
  }
});

test('sanitize drops orphan tool_results and injects user text when only tool_results remain', () => {
  const orphan = sanitizePoisonedHistory([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'ls' }] },
  ], { goal: 'ship tetris' });
  assert.equal(orphan.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')), false);
  assert.equal(orphan.some((m) => m.role === 'user' && (m.content === 'ship tetris' || lastStringUserText(orphan) === 'ship tetris')), true);

  const paired = sanitizePoisonedHistory([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'LS', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '.' }] },
  ], { goal: 'keep going' });
  const last = paired[paired.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(Array.isArray(last.content), true);
  assert.equal(last.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'tu1'), true);
  assert.equal(last.content.some((b) => b.type === 'text' && b.text === 'keep going'), true);

  const kept = sanitizePoisonedHistory([
    { role: 'user', content: 'list the repo' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] },
  ], {});
  assert.equal(lastStringUserText(kept), 'list the repo');
  const lastKept = kept[kept.length - 1];
  assert.equal(lastKept.content.some((b) => b.type === 'text' && b.text === 'list the repo'), true);
});

test('AskUser short-circuits when a goal is set', () => {
  const state = {};
  assert.equal(isGoalActive(state), false);
  assert.equal(shouldSkipAskUser({ name: 'AskUser' }, state), false);
  setGoal(state, '/goal generate tetris');
  assert.equal(isGoalActive(state), true);
  assert.equal(state.goal, 'generate tetris');
  assert.equal(shouldSkipAskUser({ name: 'AskUser' }, state), true);
  assert.equal(shouldSkipAskUser({ name: 'LS' }, state), false);
  assert.match(ASKUSER_GOAL_RESULT, /goal is already set/i);
  assert.match(goalPrompt('generate tetris'), /Do not ask what they would like to do/);
});
