/**
 * OpenAI Responses API <-> chat completions.
 *
 * WHY THIS EXISTS: some harnesses speak ONLY the Responses API. OpenAI's Codex
 * Security CLI is the case that forced it — its provider table pins
 * `wire_api: "responses"`, so pointing OPENAI_BASE_URL at this proxy got a bare
 * 404 on /v1/responses and the tool fell back to `wss://api.openai.com`,
 * bypassing the proxy entirely while looking like an auth failure.
 *
 * The zoo serves chat completions. Rather than teach the gateway a second wire
 * format, translate at the edge: Responses in, chat out, chat back, Responses
 * back. Everything between (payment, auto-bind, replay cache, metering) stays
 * on one code path and cannot drift.
 *
 * Mirrors the shape already used for Anthropic in ./anthropic.js.
 */


/**
 * Flatten Codex's `additional_tools` into chat-completions tools.
 *
 * Codex does NOT use the `tools` parameter. It declares capability as an input
 * item `{type:"additional_tools", role:"developer", tools:[...]}` whose entries
 * are either NAMESPACES (a named bag of tools) or leaf tools. Leaves come in two
 * flavours:
 *
 *   type:"function" — ordinary JSON-schema tool. Maps straight across.
 *   type:"custom"   — FREEFORM: its input is raw text, not JSON. `exec` is one,
 *                     and it is the tool through which Codex runs everything
 *                     (shell included, via tools.exec_command inside the JS).
 *
 * Chat completions has no freeform tool type, so a custom tool is wrapped as a
 * function with a single string property and unwrapped on the way back. Without
 * this the model is handed NO tools at all, answers in prose, never runs a
 * command, and the scan dies with "did not create required draft artifacts" —
 * which is what happened on every repo.
 *
 * `custom` collects the names that need unwrapping, because the response
 * translator has to know which calls to re-emit as custom_tool_call.
 */
export function toolsFromAdditional(item, custom) {
  const out = [];
  const walk = (list) => {
    for (const t of list || []) {
      if (t?.type === 'namespace') { walk(t.tools); continue; }
      if (!t?.name) continue;
      if (t.type === 'custom') {
        custom.add(t.name);
        out.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: {
              type: 'object',
              properties: {
                input: { type: 'string', description: 'Raw tool input, verbatim. Not JSON, not fenced.' },
              },
              required: ['input'],
            },
          },
        });
      } else {
        out.push({
          type: 'function',
          function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
        });
      }
    }
  };
  walk(item?.tools);
  return out;
}


/**
 * Flatten a tool result into text.
 *
 * `output` is NOT a string. Codex sends an array of content parts —
 * [{type:"input_text", text:"..."}, ...] — and `String()` on that yields
 * "[object Object],[object Object]".
 *
 * MEASURED: every one of an agent's 51 tool calls came back as [object Object].
 * It ran real commands with exit_code 0, received nothing legible, and could
 * never learn enough to write its output files. The scan then failed with
 * "did not create required draft artifacts", and the artifact directories were
 * EMPTY rather than partial — which is the tell that the agent was blind, not
 * interrupted.
 */
function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        // text / input_text / output_text all carry `text`; anything else is
        // structured and JSON is the honest rendering of it.
        if (typeof part.text === 'string') return part.text;
        return JSON.stringify(part);
      }
      return String(part);
    }).join('');
  }
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return output.text;
    if (typeof output.content === 'string') return output.content;
    return JSON.stringify(output);
  }
  return String(output);
}

/**
 * Responses request -> chat-completions request.
 *
 * `input` is the polymorphic field: a bare string, a list of role/content
 * turns, or a list of typed content parts. All three are real and a harness
 * will send whichever it feels like, so all three are handled rather than
 * assuming the documented one.
 */
export function responsesToChat(body, meta = {}) {
  const custom = meta.custom || (meta.custom = new Set());
  const extraTools = [];
  let messages = [];

  if (typeof body.input === 'string') {
    messages = [{ role: 'user', content: body.input }];
  } else if (Array.isArray(body.input)) {
    messages = body.input.map((part) => {
      if (part && typeof part === 'object') {
        // The agent loop feeds tool RESULTS back as input items. Without this
        // they become user prose, the model loses the call/result pairing and
        // re-issues the same tool call forever.
        if (part.type === 'additional_tools') {
          extraTools.push(...toolsFromAdditional(part, custom));
          return null; // it is a tool DECLARATION, not a turn
        }
        if (part.type === 'custom_tool_call_output') {
          return { role: 'tool', tool_call_id: part.call_id, content: outputText(part.output) };
        }
        if (part.type === 'custom_tool_call') {
          return {
            role: 'assistant', content: null,
            tool_calls: [{
              id: part.call_id, type: 'function',
              function: { name: part.name, arguments: JSON.stringify({ input: part.input ?? '' }) },
            }],
          };
        }
        if (part.type === 'function_call_output') {
          return { role: 'tool', tool_call_id: part.call_id, content: outputText(part.output) };
        }
        if (part.type === 'function_call') {
          return {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: part.call_id, type: 'function',
              function: { name: part.name, arguments: part.arguments ?? '{}' },
            }],
          };
        }
        if (part.role) {
          // content may itself be an array of {type:'input_text', text}
          const c = part.content;
          if (Array.isArray(c)) {
            const text = c
              .map((seg) => (typeof seg === 'string' ? seg : seg?.text ?? ''))
              .join('');
            return { role: part.role, content: text };
          }
          return { role: part.role, content: c ?? part.text ?? '' };
        }
        return { role: 'user', content: part.text ?? JSON.stringify(part) };
      }
      return { role: 'user', content: String(part) };
    }).filter(Boolean);
  } else if (Array.isArray(body.messages)) {
    messages = body.messages.map((m) => ({ role: m.role || 'user', content: m.content }));
  }

  // `instructions` is the Responses API's system prompt. Dropping it silently
  // changes the model's behaviour with no error anywhere, which is the worst
  // kind of translation bug.
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.unshift({ role: 'system', content: body.instructions });
  }

  const out = {
    model: body.model,
    messages,
  };

  // DO NOT INVENT A COMPLETION CAP.
  //
  // Codex sends `reasoning: {effort: "xhigh"}` and NO max_output_tokens — it
  // wants the model's natural limit. Defaulting to 4096 here silently truncated
  // every turn of an agent whose reasoning tokens come out of the same budget,
  // so it explored the repo across 51 tool calls and was cut off before it
  // could write scan-manifest.json / findings.json / coverage.json. The scan
  // then failed with "did not create required draft artifacts", which reads as
  // a filesystem problem and is not one.
  //
  // Only pass a cap the caller actually asked for.
  const cap = body.max_output_tokens ?? body.max_tokens;
  if (cap != null) out.max_tokens = cap;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stream) out.stream = true;
  // TOOL SHAPES DIFFER. Responses is FLAT ({type,name,parameters}); chat
  // completions is NESTED ({type,function:{name,parameters}}). Forwarding the
  // flat shape unchanged makes the upstream ignore the tools entirely — the
  // model then answers in prose, the agent never runs a shell command, and the
  // scan fails with "did not create required draft artifacts". Nothing errors.
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => (t && t.type === 'function' && !t.function
      ? { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }
      : t));
  }
  if (extraTools.length) out.tools = [...(out.tools || []), ...extraTools];
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  return out;
}

/**
 * chat-completions response -> Responses response.
 *
 * `output_text` is included because most SDK readers reach for it first; the
 * structured `output` array is what stricter clients parse. Emitting only one
 * of them makes the response work in some clients and silently look empty in
 * others.
 */
export function chatToResponses(data, requestedModel, custom) {
  const choice = (data?.choices || [])[0] || {};
  const msg = choice.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const u = data?.usage || {};

  const finish = choice.finish_reason;
  // Responses uses status, not finish_reason. "incomplete" is its word for a
  // length cut-off; mapping that to "completed" would tell a caller a truncated
  // answer was whole.
  // `tool_calls` is a NORMAL completion — the model finished its turn by asking
  // for a tool. Marking it incomplete makes the agent treat a healthy turn as a
  // truncation and abandon the loop.
  const status =
    finish === 'length' ? 'incomplete'
      : finish === 'content_filter' ? 'incomplete'
        : 'completed';

  const out = {
    id: data?.id || `resp_${Math.random().toString(36).slice(2)}`,
    object: 'response',
    created_at: data?.created || Math.floor(Date.now() / 1000),
    status,
    model: data?.model || requestedModel,
    output: buildOutput(data, msg, text, custom),
    output_text: text,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
    },
  };
  if (status === 'incomplete') {
    out.incomplete_details = { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' };
  }
  if (msg.refusal) out.output[0].content[0].refusal = msg.refusal;
  // Keep the payment receipt visible on this shape too — the whole product is
  // that you can see what a call cost.
  if (data?.x402) out.x402 = data.x402;
  return out;
}

/**
 * The `output` array: text and/or tool calls.
 *
 * A tool call is NOT a message with a funny payload — Responses models it as a
 * separate `function_call` item with its own `call_id`, and that id is what the
 * agent echoes back in `function_call_output`. Emitting a text message instead
 * loses the id and the loop cannot close.
 */
function buildOutput(data, msg, text, custom) {
  const items = [];
  if (text) {
    items.push({
      id: `msg_${(data?.id || '').slice(-16) || 'x'}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: msg.annotations || [] }],
    });
  }
  for (const tc of msg.tool_calls || []) {
    const name = tc.function?.name;
    const rawArgs = tc.function?.arguments ?? '{}';
    // A CUSTOM tool must go back as custom_tool_call carrying RAW text. We
    // wrapped its input in {"input": "..."} on the way out so a JSON-only chat
    // API could carry it; unwrap it here or Codex receives a JSON blob where it
    // expects JavaScript source and the exec sandbox rejects every call.
    if (custom?.has(name)) {
      let input = rawArgs;
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed.input === 'string') input = parsed.input;
      } catch { /* model emitted bare text; pass it through */ }
      items.push({
        id: `ctc_${tc.id}`, type: 'custom_tool_call', status: 'completed',
        call_id: tc.id, name, input,
      });
      continue;
    }
    items.push({
      id: `fc_${tc.id}`,
      type: 'function_call',
      status: 'completed',
      call_id: tc.id,
      name,
      arguments: rawArgs,
    });
  }
  return items;
}

/**
 * Emit a chat completion as a Responses-API SSE stream.
 *
 * WHY: a Responses client does not read a JSON body — it opens an event stream
 * and waits for `response.completed`. Returning the object alone closes the
 * socket with the stream half-told, which the client reports as
 * "stream disconnected before completion: stream closed before
 * response.completed" and retries forever. MEASURED against codex-security:
 * every repo failed this way on the first pass.
 *
 * The event NAMES are the contract, not the payload shape. A client that sees
 * an unknown event ignores it; a client that never sees `response.completed`
 * hangs. So the terminal events matter far more than the deltas.
 */
export function writeResponsesSse(res, data, requestedModel, upstream, custom) {
  const full = chatToResponses(data, requestedModel, custom);
  const text = full.output_text || '';
  const msgItem = full.output.find((o) => o.type === 'message');
  const calls = full.output.filter((o) => o.type === 'function_call' || o.type === 'custom_tool_call');
  const itemId = msgItem?.id || `msg_${Math.random().toString(36).slice(2, 10)}`;

  const h = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Without this a proxy in front of us buffers the whole stream and the
    // client sees nothing until the end — which looks exactly like a hang.
    'x-accel-buffering': 'no',
  };
  const settle = upstream?.headers?.get?.('x-payment-response');
  if (settle) h['x-payment-response'] = settle;
  res.writeHead(200, h);

  let seq = 0;
  const send = (type, payload) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };

  // in_progress shell first — the client builds its item tree from these
  const shell = { ...full, status: 'in_progress', output: [], output_text: '' };
  send('response.created', { response: shell });
  send('response.in_progress', { response: shell });

  const item = {
    id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [],
  };
  send('response.output_item.added', { output_index: 0, item });
  send('response.content_part.added', {
    item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });

  // One delta carrying the whole text. The upstream already finished, so
  // chunking it would fake a progressive generation that did not happen.
  if (text) {
    send('response.output_text.delta', {
      item_id: itemId, output_index: 0, content_index: 0, delta: text,
    });
  }
  send('response.output_text.done', {
    item_id: itemId, output_index: 0, content_index: 0, text,
  });
  send('response.content_part.done', {
    item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text, annotations: [] },
  });
  send('response.output_item.done', {
    output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
  });

  // TOOL CALLS GET THEIR OWN ITEMS. The non-streaming path already returns
  // them; omitting them here would make the agent work when it does not stream
  // and silently do nothing when it does — which is the configuration it
  // actually uses.
  calls.forEach((call, i) => {
    const idx = i + 1;
    const shellItem = {
      id: call.id, type: 'function_call', status: 'in_progress',
      call_id: call.call_id, name: call.name, arguments: '',
    };
    // A custom tool streams under DIFFERENT event names. Sending
    // function_call_arguments.* for one leaves the client with an item it never
    // sees populated.
    const isCustom = call.type === 'custom_tool_call';
    const payload = isCustom ? call.input : call.arguments;
    send('response.output_item.added', { output_index: idx, item: { ...shellItem, type: call.type } });
    send(isCustom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', {
      item_id: call.id, output_index: idx, delta: payload,
    });
    send(isCustom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', {
      item_id: call.id, output_index: idx, ...(isCustom ? { input: payload } : { arguments: payload }),
    });
    send('response.output_item.done', { output_index: idx, item: { ...call, status: 'completed' } });
  });

  // The one event the client is actually waiting for.
  send(full.status === 'completed' ? 'response.completed' : 'response.incomplete', { response: full });
  res.write('data: [DONE]\n\n');
  res.end();
}
