import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenResponsesTools, restoreResponsesPayload, sseNamespaceRestorer, isInvalidToolsError,
} from '../lib/responsestools.js';

// The shape Codex 0.153.4 actually sends (captured 2026-09-13): plain
// functions, namespace groups (two of which both carry a tool named `js`),
// and a web_search tool the house doors reject.
const codexBody = () => ({
  model: 'abliterated-model',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  tools: [
    { type: 'function', name: 'exec_command', strict: false, parameters: { type: 'object', properties: {} } },
    { type: 'namespace', name: 'multi_agent_v1', description: 'Agents', tools: [
      { type: 'function', name: 'close_agent', description: 'Close it', parameters: { type: 'object', properties: {} } },
    ] },
    { type: 'namespace', name: 'mcp__node_repl', tools: [
      { type: 'function', name: 'js', description: 'Run JS', parameters: { type: 'object', properties: { code: { type: 'string' } } } },
    ] },
    { type: 'namespace', name: 'mcp__cua_repl', tools: [
      { type: 'function', name: 'js', description: 'Drive apps', parameters: { type: 'object', properties: {} } },
    ] },
    { type: 'web_search', external_web_access: false },
  ],
  tool_choice: 'auto',
});

test('a body of plain function tools is left alone', () => {
  const body = { tools: [{ type: 'function', name: 'f' }], input: [] };
  const out = flattenResponsesTools(body);
  assert.equal(out.map, null);
  assert.equal(out.body, body);
});

test('namespace groups flatten to <ns>__<tool>; web_search is dropped', () => {
  const { body, map, dropped } = flattenResponsesTools(codexBody());
  assert.deepEqual(body.tools.map((t) => t.type), ['function', 'function', 'function', 'function']);
  assert.deepEqual(body.tools.map((t) => t.name), ['exec_command', 'multi_agent_v1__close_agent', 'mcp__node_repl__js', 'mcp__cua_repl__js']);
  assert.equal(body.tools[1].description, 'Agents — Close it');
  assert.deepEqual(map.get('mcp__node_repl__js'), { namespace: 'mcp__node_repl', name: 'js' });
  assert.deepEqual(map.get('mcp__cua_repl__js'), { namespace: 'mcp__cua_repl', name: 'js' });
  assert.deepEqual(dropped, ['web_search']);
});

test('flat names never collide with an existing function tool', () => {
  const b = codexBody();
  b.tools.push({ type: 'function', name: 'mcp__node_repl__js' });
  const { body, map } = flattenResponsesTools(b);
  const names = body.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(map.has('mcp__node_repl__js_2'));
});

test('history function_call items carrying a namespace get the flat name', () => {
  const b = codexBody();
  b.input.push({ type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'js', namespace: 'mcp__node_repl', arguments: '{}' });
  b.input.push({ type: 'function_call_output', call_id: 'c1', output: 'ok' });
  const { body } = flattenResponsesTools(b);
  const call = body.input.find((it) => it.type === 'function_call');
  assert.equal(call.name, 'mcp__node_repl__js');
  assert.equal('namespace' in call, false);
  assert.equal(body.input[2].type, 'function_call_output');
});

test('a history call whose namespace is no longer offered still flattens consistently', () => {
  const b = { input: [
    { type: 'function_call', call_id: 'c1', name: 'spawn', namespace: 'gone_ns', arguments: '{}' },
  ], tools: [{ type: 'function', name: 'f' }] };
  const { body, map } = flattenResponsesTools(b);
  assert.equal(body.input[0].name, 'gone_ns__spawn');
  assert.deepEqual(map.get('gone_ns__spawn'), { namespace: 'gone_ns', name: 'spawn' });
});

test('a reply function_call gets its namespace back, in JSON and SSE frames', () => {
  const { map } = flattenResponsesTools(codexBody());
  const json = { object: 'response', output: [
    { type: 'message', role: 'assistant', content: [] },
    { type: 'function_call', call_id: 'c1', name: 'mcp__node_repl__js', arguments: '{"code":"6*7"}' },
    { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: '{}' },
  ] };
  restoreResponsesPayload(json, map);
  assert.deepEqual([json.output[1].name, json.output[1].namespace], ['js', 'mcp__node_repl']);
  assert.equal('namespace' in json.output[2], false);

  const r = sseNamespaceRestorer(map);
  const frames = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"mcp__cua_repl__js","arguments":""}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"object":"response","output":[{"type":"function_call","call_id":"c1","name":"mcp__cua_repl__js","arguments":"{}"}]}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  // Feed it in awkward pieces to prove the line buffering.
  let out = '';
  for (let i = 0; i < frames.length; i += 37) out += r.push(frames.slice(i, i + 37));
  out += r.flush();
  const datas = out.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  assert.equal(datas[0].item.name, 'js');
  assert.equal(datas[0].item.namespace, 'mcp__cua_repl');
  assert.equal(datas[1].response.output[0].namespace, 'mcp__cua_repl');
  assert.ok(out.includes('data: [DONE]'));
  assert.ok(out.startsWith('event: response.output_item.added\n'));
});

test('recognises the gateway invalid_tools 400', () => {
  assert.equal(isInvalidToolsError({ error: { code: 'invalid_tools', message: 'Invalid tools for this model request.', param: 'tools' } }), true);
  assert.equal(isInvalidToolsError({ error: { message: 'Insufficient credits' } }), false);
  assert.equal(isInvalidToolsError(null), false);
});
