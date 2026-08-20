import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isClaudeSubagentTool, claudeSubagentSpec, claudeSubagentHopText, tuiSubagentInput,
} from '../lib/grokui-subagents.js';

test('Task and Agent tools are Claude subagents; Write/Bash are not', () => {
  assert.equal(isClaudeSubagentTool('Task'), true);
  assert.equal(isClaudeSubagentTool('task'), true);
  assert.equal(isClaudeSubagentTool('Agent'), true);
  assert.equal(isClaudeSubagentTool('spawn_agent'), true);
  assert.equal(isClaudeSubagentTool('Write'), false);
  assert.equal(isClaudeSubagentTool('Bash'), false);
  assert.equal(isClaudeSubagentTool('Read'), false);
});

test('claudeSubagentSpec prefers description, then type, then prompt words', () => {
  assert.deepEqual(
    claudeSubagentSpec('Task', { description: 'Worker A', prompt: 'build the frontend', subagent_type: 'generalPurpose' }),
    { name: 'Worker A', task: 'build the frontend' },
  );
  assert.equal(claudeSubagentSpec('Task', { subagent_type: 'Explore', prompt: 'scan the repo' }).name, 'Explore');
  assert.equal(claudeSubagentSpec('Agent', { name: 'planner', prompt: 'plan the cut' }).name, 'planner');
  const generic = claudeSubagentSpec('Task', { prompt: 'wire the sidebar agents now' });
  assert.equal(generic.name, 'wire the sidebar agents now'.split(' ').slice(0, 4).join(' '));
  assert.equal(generic.task, 'wire the sidebar agents now');
});

test('compact hops are Messaged N Bots, never tool JSON', () => {
  const a = { child: { id: '1', name: 'Worker A' }, fresh: true };
  const b = { child: { id: '2', name: 'Worker B' }, fresh: true };
  assert.equal(claudeSubagentHopText([a]), 'Spawned Worker A.');
  assert.equal(claudeSubagentHopText([{ ...a, fresh: false }]), 'Messaged Worker A.');
  assert.equal(claudeSubagentHopText([a, b]), 'Messaged 2 Bots');
  assert.equal(claudeSubagentHopText([a, a, b]), 'Messaged 2 Bots');
  assert.equal(claudeSubagentHopText([]), '');
  assert.doesNotMatch(claudeSubagentHopText([a, b]), /tool_use|file_path|RUN:|READ:/);
});

test('TUI Task rest is a description, not a file_path', () => {
  assert.deepEqual(tuiSubagentInput('Worker A build it'), {
    description: 'Worker A build it',
    prompt: 'Worker A build it',
  });
});
