/**
 * Anthropic Messages API shape, served by the openzoo proxy.
 *
 * WHY: harnesses that speak Anthropic (Claude Code via ANTHROPIC_BASE_URL, the
 * Anthropic SDKs) could not use the zoo at all — it speaks OpenAI chat
 * completions. Pointing DNS or /etc/hosts at localhost does not work: the TLS
 * cert will not match and the client refuses the connection. A translating
 * endpoint is the only mechanism that actually routes such a harness through
 * x402 payment, and it needs no system changes.
 *
 * Translation is deliberately conservative: what maps cleanly is mapped, and
 * anything unrecognised is passed through rather than dropped, so a field this
 * file has never heard of still reaches the model.
 */

/** Anthropic content blocks -> an OpenAI message content value. */
function blocksToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b?.type === 'text') parts.push({ type: 'text', text: b.text ?? '' });
    else if (b?.type === 'image' && b.source?.type === 'base64') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
      });
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts.length ? parts : '';
}

/**
 * Anthropic request -> OpenAI request.
 *
 * The two shapes disagree on three things that matter: `system` is a top-level
 * field (OpenAI wants a system MESSAGE), tool results are user-turn blocks
 * (OpenAI wants role:"tool" messages), and tool schemas live under
 * `input_schema` rather than `parameters`.
 */
export function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map((b) => b?.text ?? '').join('\n') : '');
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : null;
    const toolResults = blocks?.filter((b) => b?.type === 'tool_result') ?? [];
    const toolUses = blocks?.filter((b) => b?.type === 'tool_use') ?? [];

    // A user turn carrying tool_result blocks becomes one OpenAI tool message
    // per result — they are answers to specific calls, not prose.
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? ''),
      });
    }

    if (toolUses.length) {
      messages.push({
        role: 'assistant',
        content: blocksToOpenAI(blocks.filter((b) => b?.type === 'text')) || null,
        tool_calls: toolUses.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        })),
      });
      continue;
    }

    const rest = blocks ? blocks.filter((b) => b?.type !== 'tool_result') : m.content;
    const content = blocksToOpenAI(rest);
    if (content && (!Array.isArray(content) || content.length)) {
      messages.push({ role: m.role, content });
    }
  }

  const out = { ...body, messages };
  delete out.system;
  delete out.anthropic_version;
  delete out.metadata;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t?.name && t?.input_schema)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    if (!out.tools.length) delete out.tools;
  }
  if (body.tool_choice?.type === 'auto') out.tool_choice = 'auto';
  else if (body.tool_choice?.type === 'any') out.tool_choice = 'required';
  else if (body.tool_choice?.type === 'tool') {
    out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  }
  if (body.stop_sequences) { out.stop = body.stop_sequences; delete out.stop_sequences; }
  return out;
}

const STOP_REASON = {
  stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence',
};

/** OpenAI completion -> Anthropic message. */
export function openAIToAnthropic(data, requestedModel) {
  const choice = (data.choices ?? [])[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const t of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(t.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: t.id, name: t.function?.name, input });
  }
  return {
    id: data.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel ?? data.model,
    content,
    stop_reason: STOP_REASON[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Emit a finished completion as an Anthropic SSE stream.
 *
 * The zoo settles payment before it answers, so there is nothing to stream
 * until generation is done — same reason the OpenAI path re-emits chunks. A
 * client that asked for a stream and got a JSON body treats the connection as
 * dead and RETRIES, and every retry is another payment.
 */
export function writeAnthropicSse(res, message, upstream) {
  const headers = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' };
  const settle = upstream?.headers?.get?.('x-payment-response');
  if (settle) headers['x-payment-response'] = settle;
  res.writeHead(200, headers);
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

  ev('message_start', {
    message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } },
  });
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  ev('message_stop', {});
  res.end();
}
