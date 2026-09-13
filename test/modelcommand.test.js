import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectModelCommand, lastUserText, matchCatalogId, normaliseModelId, closestIds,
  modelFilePath, readOverride, writeOverride, clearOverride, applyModelCommand,
  shapeForPath, chatCompletionReply, responsesReply, responsesStreamEvents,
  anthropicReply, anthropicStreamEvents, serveModelCommand,
} from '../lib/modelcommand.js';

const IDS = ['claude-fable-5', 'claude-fable-5-1', 'venice/claude-fable-5'];

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

test('chat completions: the command is read off the LAST user turn', () => {
  assert.deepEqual(detectModelCommand({ messages: [{ role: 'user', content: '/model fable-5' }] }), { arg: 'fable-5' });
  // An earlier /model must not re-fire on an unrelated question — that would
  // switch models behind the user's back mid-conversation.
  assert.equal(detectModelCommand({
    messages: [
      { role: 'user', content: '/model fable-5' },
      { role: 'assistant', content: 'Switched.' },
      { role: 'user', content: 'what is 2+2?' },
    ],
  }), null);
});

test('chat completions: array content parts', () => {
  assert.deepEqual(detectModelCommand({
    messages: [{ role: 'user', content: [{ type: 'text', text: '  /model claude-fable-5-1 ' }] }],
  }), { arg: 'claude-fable-5-1' });
});

test('responses api: string input, array input, and input_text parts', () => {
  assert.deepEqual(detectModelCommand({ input: '/model fable-5' }), { arg: 'fable-5' });
  assert.deepEqual(detectModelCommand({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '/model fable-5' }] },
    ],
  }), { arg: 'fable-5' });
  // Codex sometimes sends content as a bare string on an item.
  assert.deepEqual(detectModelCommand({ input: [{ role: 'user', content: '/MODEL reset' }] }), { arg: 'reset' });
});

test('bare /model is the status form, and non-commands pass through', () => {
  assert.deepEqual(detectModelCommand({ messages: [{ role: 'user', content: '/model' }] }), { arg: '' });
  assert.equal(detectModelCommand({ messages: [{ role: 'user', content: 'how do I use /model fable-5?' }] }), null);
  assert.equal(detectModelCommand({ messages: [{ role: 'user', content: '/models' }] }), null);
  assert.equal(detectModelCommand({ messages: [] }), null);
  assert.equal(detectModelCommand(null), null);
});

test('lastUserText ignores system and assistant turns', () => {
  assert.equal(lastUserText({
    messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'system', content: 'rules' }],
  }), 'first');
});

// ---------------------------------------------------------------------------
// matcher — must mirror the gateway's rule, or we confirm a switch the gateway
// then refuses
// ---------------------------------------------------------------------------

test('normalise drops the vendor prefix and folds . _ and spaces to -', () => {
  assert.equal(normaliseModelId('Venice/Claude_Fable 5.1'), 'claude-fable-5-1');
  assert.equal(normaliseModelId('--claude--fable--5--'), 'claude-fable-5');
});

test('suffix match, exact match, and the shortest/lexical tiebreak', () => {
  assert.equal(matchCatalogId('fable-5', IDS), 'claude-fable-5');
  assert.equal(matchCatalogId('fable-5.1', IDS), 'claude-fable-5-1');
  assert.equal(matchCatalogId('claude-fable-5', IDS), 'claude-fable-5');
  assert.equal(matchCatalogId('CLAUDE_FABLE_5', IDS), 'claude-fable-5');
});

test('too-short and unknown names resolve to nothing, never to a guess', () => {
  assert.equal(matchCatalogId('xx', IDS), null);
  assert.equal(matchCatalogId('gpt-9-turbo', IDS), null);
  assert.equal(matchCatalogId('', IDS), null);
});

test('a miss still suggests something to type next', () => {
  assert.deepEqual(closestIds('fabel-5', IDS, 3).slice(0, 1), ['claude-fable-5']);
});

// ---------------------------------------------------------------------------
// persistence — the whole point is that it survives a proxy restart
// ---------------------------------------------------------------------------

test('override round-trips through ~/.openzoo/model in a temp HOME', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oz-model-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = modelFilePath();
    assert.equal(file, path.join(home, '.openzoo', 'model'));
    assert.equal(readOverride(file), null);

    const out = applyModelCommand('fable-5', IDS, file);
    assert.match(out.text, /^Switched to claude-fable-5\./);
    assert.equal(out.model, 'claude-fable-5');
    assert.equal(out.changed, true);
    assert.equal(readFileSync(file, 'utf8').trim(), 'claude-fable-5');
    // A fresh read (what a restarted proxy does) sees it.
    assert.equal(readOverride(file), 'claude-fable-5');

    const status = applyModelCommand('', IDS, file);
    assert.match(status.text, /Model override: claude-fable-5/);

    const miss = applyModelCommand('xx', IDS, file);
    assert.match(miss.text, /No model matches "xx"/);
    assert.equal(readOverride(file), 'claude-fable-5', 'a miss must not clear the working override');

    const reset = applyModelCommand('reset', IDS, file);
    assert.match(reset.text, /Cleared the model override \(was claude-fable-5\)/);
    assert.equal(existsSync(file), false);
    assert.equal(readOverride(file), null);

    writeOverride('claude-fable-5-1', file);
    assert.equal(readOverride(file), 'claude-fable-5-1');
    clearOverride(file);
    assert.equal(readOverride(file), null);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('with no catalog the id is taken as typed rather than refused', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oz-model-'));
  try {
    const file = path.join(home, '.openzoo', 'model');
    const out = applyModelCommand('some/new-model', [], file);
    assert.equal(out.model, 'some/new-model');
    assert.equal(readOverride(file), 'some/new-model');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// reply shapes
// ---------------------------------------------------------------------------

/** Records everything written, so the synthesisers can be checked without a socket. */
function fakeRes() {
  return {
    code: null, headers: null, chunks: [], ended: false,
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    write(s) { this.chunks.push(s); return true; },
    end(s) { if (s) this.chunks.push(s); this.ended = true; },
    get body() { return this.chunks.join(''); },
  };
}

/** event/data pairs out of an SSE stream, in wire order. */
function parseSse(body) {
  return body.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? null;
    const data = /^data: (.+)$/m.exec(block)?.[1] ?? null;
    return { event, data: data ? JSON.parse(data) : null };
  });
}

test('shapeForPath tells the four paid paths apart', () => {
  assert.equal(shapeForPath('/v1/responses'), 'responses');
  assert.equal(shapeForPath('/v1/messages'), 'anthropic');
  assert.equal(shapeForPath('/v1/chat/completions'), 'chat');
  assert.equal(shapeForPath('/v1/completions'), 'chat');
});

test('chat completion reply is a well-formed, zero-usage completion', () => {
  const d = chatCompletionReply('hi', 'claude-fable-5', 1700000000000);
  assert.equal(d.id, 'chatcmpl-model-1700000000000');
  assert.equal(d.object, 'chat.completion');
  assert.equal(d.choices[0].message.content, 'hi');
  assert.equal(d.choices[0].finish_reason, 'stop');
  assert.deepEqual(d.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('responses reply carries an output_text message', () => {
  const d = responsesReply('hi', 'claude-fable-5', 1700000000000);
  assert.equal(d.object, 'response');
  assert.equal(d.status, 'completed');
  assert.deepEqual(d.output[0].content, [{ type: 'output_text', text: 'hi', annotations: [] }]);
});

test('responses SSE fires the events in the order Codex parses them', () => {
  const res = fakeRes();
  serveModelCommand(res, { rawPath: '/v1/responses', stream: true, text: 'switched', model: 'claude-fable-5', now: 1700000000000 });
  assert.equal(res.code, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.ended, true);

  const evs = parseSse(res.body);
  assert.deepEqual(evs.map((e) => e.event), [
    'response.created',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  // Every event names its own type and numbers itself from 0.
  evs.forEach((e, i) => {
    assert.equal(e.data.type, e.event);
    assert.equal(e.data.sequence_number, i);
  });
  assert.equal(evs[0].data.response.status, 'in_progress');
  assert.deepEqual(evs[0].data.response.output, []);
  assert.equal(evs[3].data.delta, 'switched');
  assert.equal(evs[4].data.text, 'switched');
  const last = evs[7].data.response;
  assert.equal(last.status, 'completed');
  assert.equal(last.output[0].content[0].text, 'switched');
  assert.deepEqual(last.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  // Same message id all the way through, or the client cannot stitch the parts.
  const ids = new Set([evs[1].data.item.id, evs[2].data.item_id, evs[6].data.item.id]);
  assert.equal(ids.size, 1);
});

test('responses non-stream serves JSON, not SSE', () => {
  const res = fakeRes();
  serveModelCommand(res, { rawPath: '/v1/responses', stream: false, text: 'ok', model: 'm' });
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(res.body).object, 'response');
});

test('chat streaming goes through the proxy own SSE writer', () => {
  const res = fakeRes();
  let seen = null;
  serveModelCommand(res, {
    rawPath: '/v1/chat/completions', stream: true, text: 'ok', model: 'm',
    serveAsSse: (r, data) => { seen = data; r.end(); },
  });
  assert.equal(seen.choices[0].message.content, 'ok');
});

test('anthropic messages: object and event script', () => {
  const d = anthropicReply('ok', 'm', 1700000000000);
  assert.equal(d.type, 'message');
  assert.deepEqual(d.content, [{ type: 'text', text: 'ok' }]);
  assert.equal(d.stop_reason, 'end_turn');

  const res = fakeRes();
  serveModelCommand(res, { rawPath: '/v1/messages', stream: true, text: 'ok', model: 'm' });
  assert.deepEqual(parseSse(res.body).map((e) => e.event), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.equal(anthropicStreamEvents('ok', 'm')[2].data.delta.text, 'ok');
});

// --- per-chat overrides -----------------------------------------------------
import { chatKeyFrom, readOverrideFor, writeOverrideFor, clearOverrideFor, chatModelsPath } from '../lib/modelcommand.js';
import { writeFileSync as wfs } from 'node:fs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'ozchat-'));

test('the chat key comes from whichever id Codex sent', () => {
  assert.equal(chatKeyFrom({ 'thread-id': 't1' }), 't1');
  assert.equal(chatKeyFrom({ 'session-id': 's1' }), 's1');
  // Two panes of one window are two chats, so the :N suffix must survive.
  assert.equal(chatKeyFrom({ 'x-codex-window-id': 'w1:0' }), 'w1:0');
  assert.equal(chatKeyFrom({}, { prompt_cache_key: 'p1' }), 'p1');
  assert.equal(chatKeyFrom({}, { client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'm1' }) } }), 'm1');
  assert.equal(chatKeyFrom({}, {}), '');
});

test('two chats hold two different models, and an unkeyed caller gets the default', () => {
  const home = tmpHome();
  const file = path.join(home, '.openzoo', 'model');
  const chatFile = chatModelsPath(home);

  writeOverrideFor('chatA', 'abliterated-model', file, chatFile);
  writeOverrideFor('chatB', 'claude-fable-5-1', file, chatFile);
  assert.equal(readOverrideFor('chatA', file, chatFile), 'abliterated-model');
  assert.equal(readOverrideFor('chatB', file, chatFile), 'claude-fable-5-1');

  // No entry of its own → machine-wide default, not another chat's pick.
  assert.equal(readOverrideFor('chatC', file, chatFile), null);
  wfs(file, 'grok-4.6\n');
  assert.equal(readOverrideFor('chatC', file, chatFile), 'grok-4.6');
  assert.equal(readOverrideFor('', file, chatFile), 'grok-4.6');
  // A chat with its own pick ignores the default.
  assert.equal(readOverrideFor('chatA', file, chatFile), 'abliterated-model');

  // Clearing one chat leaves the other alone.
  clearOverrideFor('chatA', file, chatFile);
  assert.equal(readOverrideFor('chatA', file, chatFile), 'grok-4.6');
  assert.equal(readOverrideFor('chatB', file, chatFile), 'claude-fable-5-1');
});

test('applyModelCommand writes to the chat, not the machine', () => {
  const home = tmpHome();
  const file = path.join(home, '.openzoo', 'model');
  const ids = ['abliterated-model', 'claude-fable-5-1'];
  const outA = applyModelCommand('abliterated', ids, file, 'winA');
  assert.match(outA.text, /^Switched to abliterated-model\. This chat/);
  // The machine-wide file is untouched by a keyed switch.
  assert.equal(existsSync(file), false);
  const outB = applyModelCommand('fable-5-1', ids, file, 'winB');
  assert.equal(outB.model, 'claude-fable-5-1');
  assert.equal(readOverrideFor('winA', file, chatModelsPath(os.homedir())) !== 'claude-fable-5-1', true);
  // Unkeyed still says "Every chat" and uses the single-line file.
  const outG = applyModelCommand('abliterated', ids, file, '');
  assert.match(outG.text, /^Switched to abliterated-model\. Every chat/);
  assert.equal(readFileSync(file, 'utf8').trim(), 'abliterated-model');
});
