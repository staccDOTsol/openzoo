/**
 * OpenAI chat-completions SSE -> Responses API SSE, frame by frame.
 *
 * WHY: Codex Security pins wire_api=responses and waits ~10s for
 * `response.created`. The previous path buffered the whole chat completion
 * (Opus reasoning can sit silent for longer than that) then dumped the
 * event sequence at the end. Codex reported "connection interrupted".
 *
 * Same shape as streamOpenAIToAnthropic: write headers immediately, ping on
 * silent reasoning chunks, translate content/tool deltas as they arrive.
 */
export function streamOpenAIToResponses(res, upstream, requestedModel, custom) {
  const headers = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
  const settle = upstream?.headers?.get?.('x-payment-response');
  if (settle) headers['x-payment-response'] = settle;
  res.writeHead(200, headers);

  let seq = 0;
  const send = (type, payload = {}) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };

  const customNames = custom instanceof Set ? custom : new Set(custom || []);
  const responseId = `resp_${Date.now().toString(36)}`;
  const itemId = `msg_${Math.random().toString(36).slice(2, 10)}`;
  const shell = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: requestedModel,
    output: [],
    output_text: '',
  };

  // First bytes NOW — do not wait for a content token. Codex's watchdog is ~10s
  // and a reasoning model can think for longer than that before delta.content.
  send('response.created', { response: shell });
  send('response.in_progress', { response: shell });

  let textStarted = false;
  let text = '';
  const tools = [];

  const unwrapCustom = (args) => {
    try {
      const o = JSON.parse(args);
      if (o && typeof o.input === 'string') return o.input;
    } catch { /* raw text */ }
    return args;
  };

  const ensureText = () => {
    if (textStarted) return;
    textStarted = true;
    send('response.output_item.added', {
      output_index: 0,
      item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    });
    send('response.content_part.added', {
      item_id: itemId, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const toolIndexBase = () => (textStarted ? 1 : 0);

  const onChunk = (d) => {
    const ch = (d.choices ?? [])[0];
    if (!ch) {
      send('response.in_progress', { response: shell });
      return;
    }
    const delta = ch.delta ?? {};
    let spoke = false;
    if (typeof delta.content === 'string' && delta.content.length) {
      spoke = true;
      ensureText();
      text += delta.content;
      send('response.output_text.delta', {
        item_id: itemId, output_index: 0, content_index: 0, delta: delta.content,
      });
    }
    for (const tc of (delta.tool_calls ?? [])) {
      spoke = true;
      const idx = Number.isInteger(tc.index) ? tc.index : tools.length;
      if (!tools[idx]) {
        const id = tc.id || `call_${idx}`;
        const name = tc.function?.name || '';
        const isCustom = customNames.has(name);
        tools[idx] = {
          id, call_id: id, name, arguments: '',
          type: isCustom ? 'custom_tool_call' : 'function_call',
        };
        send('response.output_item.added', {
          output_index: toolIndexBase() + idx,
          item: {
            id, type: tools[idx].type, status: 'in_progress',
            call_id: id, name, arguments: '',
          },
        });
      }
      const piece = tc.function?.arguments || '';
      if (!piece) continue;
      tools[idx].arguments += piece;
      const isCustom = tools[idx].type === 'custom_tool_call';
      // Custom tools want raw text, but stream pieces are JSON fragments of
      // {input:"..."}. Buffer and emit once at finish. Function tools stream.
      if (!isCustom) {
        send('response.function_call_arguments.delta', {
          item_id: tools[idx].id,
          output_index: toolIndexBase() + idx,
          delta: piece,
        });
      }
    }
    if (!spoke) send('response.in_progress', { response: shell });
  };

  const finish = () => {
    if (textStarted) {
      send('response.output_text.done', {
        item_id: itemId, output_index: 0, content_index: 0, text,
      });
      send('response.content_part.done', {
        item_id: itemId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      });
      send('response.output_item.done', {
        output_index: 0,
        item: {
          id: itemId, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      });
    }
    const output = [];
    if (textStarted) {
      output.push({
        id: itemId, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    tools.forEach((call, i) => {
      if (!call) return;
      const idx = toolIndexBase() + i;
      const isCustom = call.type === 'custom_tool_call';
      const raw = isCustom ? unwrapCustom(call.arguments) : call.arguments;
      send(isCustom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', {
        item_id: call.id, output_index: idx, delta: isCustom ? raw : '',
      });
      send(isCustom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', {
        item_id: call.id, output_index: idx,
        ...(isCustom ? { input: raw } : { arguments: call.arguments }),
      });
      const item = isCustom
        ? { id: call.id, type: 'custom_tool_call', status: 'completed', call_id: call.call_id, name: call.name, input: raw }
        : { id: call.id, type: 'function_call', status: 'completed', call_id: call.call_id, name: call.name, arguments: call.arguments };
      send('response.output_item.done', { output_index: idx, item });
      output.push(item);
    });
    send('response.completed', {
      response: { ...shell, status: 'completed', output, output_text: text },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  return { onChunk, finish };
}
