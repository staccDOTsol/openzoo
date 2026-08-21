/**
 * Agent Loop — async generator yielding 13 event types.
 * Handles streaming, tool calls, thinking, auto-compaction, hooks, multi-provider.
 */
import { streamResponse, accumulateStream } from './streaming.mjs';
import { ContextManager } from './context-manager.mjs';
import { buildSystemPrompt } from './system-prompt.mjs';
import {
    anthropicHeaders,
    compactDisabled,
    createSpillHud,
    isAutoModel,
    isPaymentError,
    messagesUrl,
    paymentErrorFromResponse,
    resolveApiModel,
    shouldEnableThinking,
    ZOO_LOCAL_BASE,
} from './openzoo.mjs';
import { persistUserTurn, ToolRepeatGuard, isHarnessUserText, rewriteFindCommand, rejectHarnessBash } from './savings.mjs';
import {
    ASKUSER_GOAL_RESULT,
    isGoalActive,
    sanitizePoisonedHistory,
    setGoal,
    shouldSkipAskUser,
} from './goal.mjs';

/** Maximum number of consecutive tool-use continuation turns before aborting. */
const MAX_TOOL_RECURSION_DEPTH = 50;

/** Same delays as lib/fetch.js — inlined so packed OCC does not import openzoo. */
export const FETCH_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000]);

export function isRetryableFetchError(err) {
    if (!err) return false;
    const name = String(err.name || '');
    const msg = String(err.message || '');
    const code = String(err.code || err.cause?.code || '');
    const blob = `${name} ${msg} ${code}`;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    if (msg === 'fetch failed' || /fetch failed/i.test(msg)) return true;
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|UND_ERR/i.test(blob)) return true;
    return false;
}

export function isRetryableHttpStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

/** 400 / 401 / 402 / 403 / 404 and other 4xx except 429 — do not retry. */
export function isNoRetryHttpStatus(status) {
    const n = Number(status);
    if (n === 429) return false;
    return n >= 400 && n < 500;
}

export function isPoisonHttp400(status, body) {
    if (Number(status) !== 400) return false;
    const s = String(body || '');
    return /No user query|tool_calls|preceding message with tool_calls|tool result/i.test(s);
}

function jitterMs(base, jitter = 0.2) {
    const j = Number.isFinite(jitter) ? jitter : 0.2;
    return Math.max(0, base * (1 + (Math.random() * 2 - 1) * j));
}

/**
 * Retry transient network / 429 / 5xx. Same body/headers each try.
 * Never retries a completed 200. Never retries 402 or other 4xx except 429.
 * 400 poison is handled by the caller (sanitize + one retry), not here.
 */
export async function fetchRetry(url, init = {}, opts = {}) {
    const delays = opts.delays || FETCH_RETRY_DELAYS_MS;
    const fetchImpl = opts.fetch || globalThis.fetch;
    const jitter = opts.jitter == null ? 0.2 : opts.jitter;
    const maxAttempts = delays.length + 1;
    let lastRes = null;
    let lastErr = null;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetchImpl(url, init);
            lastRes = res;
            if (res.ok || isNoRetryHttpStatus(res.status) || !isRetryableHttpStatus(res.status)) {
                return res;
            }
            lastErr = Object.assign(new Error('HTTP ' + res.status), { status: res.status, response: res });
        } catch (err) {
            lastErr = err;
            if (!isRetryableFetchError(err)) throw err;
        }
        if (i >= maxAttempts - 1) break;
        const wait = jitterMs(delays[Math.min(i, delays.length - 1)], jitter);
        opts.onRetry?.({ attempt: i + 1, wait, error: lastErr, response: lastRes });
        await new Promise((r) => setTimeout(r, wait));
    }
    opts.onGiveUp?.({ error: lastErr, response: lastRes });
    if (lastRes) return lastRes;
    throw lastErr;
}

export { ASKUSER_GOAL_RESULT, isGoalActive, sanitizePoisonedHistory, shouldSkipAskUser };

export function createAgentLoop({ model, tools, permissions, settings, hooks, cascade = null, sessionManager = null }) {
    const contextManager = new ContextManager(settings.maxContextTokens || 180000, {
        disableCompact: compactDisabled(process.env, settings),
    });
    const repeatGuard = new ToolRepeatGuard();
    const spillHud = createSpillHud();

    // Build system prompt using the new builder
    const promptResult = buildSystemPrompt({
        cwd: process.cwd(),
        tools: tools.list?.() || [],
        override: settings.systemPromptOverride,
        addDirs: settings.addDirs,
    });

    const state = {
        messages: [],
        systemPrompt: promptResult.full,
        turnCount: 0,
        tokenUsage: { input: 0, output: 0 },
        model,
        tools,
        _contextManager: contextManager,
        _cascade: cascade,
        _sessionManager: sessionManager,
        _repeatGuard: repeatGuard,
        _spillHud: spillHud,
    };

    // Self-optimization bookkeeping for the current top-level task (opt-in).
    let _optTask = null; // { model, complexity, startedAt, tokensAtStart }

    /** Record the outcome of the current task, if self-optimization is on. */
    function recordOptOutcome(success) {
        if (!cascade || !_optTask) return;
        const inputDelta = state.tokenUsage.input - _optTask.tokensAtStart.input;
        const outputDelta = state.tokenUsage.output - _optTask.tokensAtStart.output;
        try {
            cascade.recordOutcome({
                model: _optTask.model,
                success,
                latencyMs: Date.now() - _optTask.startedAt,
                inputTokens: inputDelta >= 0 ? inputDelta : 0,
                outputTokens: outputDelta >= 0 ? outputDelta : 0,
                complexity: _optTask.complexity,
                task: _optTask.task,
            });
        } catch { /* best-effort */ }
        _optTask = null;
    }

    async function* run(userMessage, options = {}) {
        const depth = (options._depth || 0);

        // Guard against runaway tool-call recursion
        if (depth >= MAX_TOOL_RECURSION_DEPTH) {
            yield { type: 'error', message: `Max tool recursion depth (${MAX_TOOL_RECURSION_DEPTH}) reached. Stopping to prevent infinite loop.` };
            yield { type: 'stop', reason: 'max_recursion' };
            return;
        }

        // Add user message (skip for continuation turns). Persist BEFORE any
        // API call or TUI refresh — refresh must not forget the turn.
        if (userMessage && !options.continuation) {
            if (isHarnessUserText(userMessage)) {
                yield { type: 'error', message: 'Ask-mode text harness is disabled. Use Claude Code tools, not RUN:/WRITE:/SPAWN:.' };
                yield { type: 'stop', reason: 'harness_rejected' };
                return;
            }
            if (/^\/goal\b/i.test(String(userMessage))) {
                setGoal(state, userMessage);
            }
            state.messages = contextManager.addMessage(state.messages, {
                role: 'user',
                content: userMessage,
            });
            state.turnCount++;
            if (sessionManager) persistUserTurn(sessionManager, state);

            // Opt-in cost-cascade routing: pick the cheapest good-enough model
            // for this task and record outcome bookkeeping. Default path (no
            // cascade) leaves state.model exactly as constructed.
            if (cascade) {
                const route = cascade.decide(userMessage);
                state.model = route.model;
                state._lastRoute = route;
                _optTask = {
                    model: route.model,
                    complexity: route.complexity,
                    startedAt: Date.now(),
                    tokensAtStart: { input: state.tokenUsage.input, output: state.tokenUsage.output },
                    task: String(userMessage).slice(0, 120),
                };
            }
        }

        // Check max turns
        if (settings.maxTurns && state.turnCount > settings.maxTurns) {
            yield { type: 'error', message: `Max turns (${settings.maxTurns}) reached.` };
            yield { type: 'stop', reason: 'max_turns' };
            return;
        }

        // Auto-compact if needed (zoo: DISABLE_COMPACT — proxy already spills)
        if (!compactDisabled(process.env, settings) && contextManager.shouldCompact(state.messages)) {
            yield { type: 'compaction', count: contextManager.compactionCount + 1 };
            state.messages = contextManager.compact(state.messages);
        }

        yield { type: 'stream_request_start', turn: state.turnCount };

        // Detect provider and call API. Use state.model so an opt-in cascade
        // pick takes effect; defaults to the constructed model otherwise.
        const activeModel = state.model || model;
        const provider = detectProvider(activeModel);
        let response;

        try {
            if (settings.stream !== false) {
                // Streaming mode
                response = await callApiStreaming(provider, activeModel, state, tools.list(), settings);
                const collectedContent = [];
                let currentText = '';
                let currentThinking = '';

                for await (const event of response.events) {
                    if (event.type === 'content_block_start') {
                        if (event.content_block?.type === 'thinking') {
                            currentThinking = '';
                        }
                    } else if (event.type === 'content_block_delta') {
                        if (event.delta?.type === 'text_delta') {
                            currentText += event.delta.text;
                            yield { type: 'stream_event', text: event.delta.text };
                        } else if (event.delta?.type === 'thinking_delta') {
                            currentThinking += event.delta.thinking;
                            yield { type: 'thinking', text: event.delta.thinking };
                        }
                    } else if (event.type === 'ping') {
                        // Keepalive, ignore
                    }
                }

                // Use the accumulated message
                response = response.accumulated;
            } else {
                // Non-streaming mode
                response = await callApi(provider, activeModel, state, tools.list(), settings);
            }
        } catch (err) {
            recordOptOutcome(false);
            if (isPaymentError(err)) {
                yield { type: 'error', message: err.message, paymentRequired: true, status: 402 };
                yield { type: 'stop', reason: 'payment_required' };
                return;
            }
            yield { type: 'error', message: err.message };
            return;
        }

        // Track token usage
        if (response.usage) {
            state.tokenUsage.input += response.usage.input_tokens || 0;
            state.tokenUsage.output += response.usage.output_tokens || 0;
        }

        // Build assistant message for history
        const assistantMessage = { role: 'assistant', content: response.content };
        state.messages.push(assistantMessage);

        // Process content blocks
        const toolUseBlocks = [];

        for (const block of response.content || []) {
            if (block.type === 'text') {
                yield { type: 'assistant', content: block.text };
            }

            if (block.type === 'thinking') {
                yield { type: 'thinking_complete', thinking: block.thinking };
            }

            if (block.type === 'tool_use') {
                toolUseBlocks.push(block);
            }
        }

        // Process tool calls
        if (toolUseBlocks.length > 0) {
            const toolResults = [];

            for (const block of toolUseBlocks) {
                // Run pre-tool hooks
                if (hooks) {
                    const hookResult = await hooks.runPreToolUse(block.name, block.input);
                    if (!hookResult.allow) {
                        yield { type: 'hookPermissionResult', tool: block.name, allowed: false, message: hookResult.message };
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: `Blocked by hook: ${hookResult.message}`,
                        });
                        continue;
                    }
                }

                // Check permission
                const allowed = await permissions.check(block.name, block.input);
                if (!allowed) {
                    yield { type: 'hookPermissionResult', tool: block.name, allowed: false };
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: 'Permission denied',
                    });
                    continue;
                }

                // A live /goal must not block the TUI on AskUser readline.
                if (shouldSkipAskUser(block, state)) {
                    yield { type: 'result', tool: block.name, result: ASKUSER_GOAL_RESULT };
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: ASKUSER_GOAL_RESULT,
                    });
                    continue;
                }

                // Execute tool
                yield { type: 'tool_progress', tool: block.name, status: 'running' };

                let result;
                const input = { ...block.input };
                if (block.name === 'Bash' && input.command) {
                    const harness = rejectHarnessBash(input.command);
                    if (harness) {
                        result = harness;
                    } else {
                        input.command = rewriteFindCommand(input.command, settings.cwd || process.cwd());
                    }
                }
                const skip = result ? null : repeatGuard.check(block.name, input);
                if (skip?.skip) {
                    result = skip.message;
                } else if (!result) {
                    try {
                        result = await tools.call(block.name, input);
                    } catch (err) {
                        result = `Tool error: ${err.message}`;
                    }
                    repeatGuard.record(block.name, input, result);
                }

                // Run post-tool hooks
                if (hooks) {
                    result = await hooks.runPostToolUse(block.name, result);
                }

                yield { type: 'result', tool: block.name, result };

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }

            // Add tool results as a single user message
            state.messages.push({ role: 'user', content: toolResults });

            // Recursive: continue the loop after tool execution
            yield* run(null, { continuation: true, _depth: depth + 1 });
            return;
        }

        // No tool calls — check stop hooks
        if (hooks) {
            const allowStop = await hooks.runStop();
            if (!allowStop) {
                // Continue via tools — never inject NUDGE / RUN:/WRITE: harness text.
                yield* run(null, { continuation: true, _depth: depth + 1 });
                return;
            }
        }

        // Task completed normally — record a successful outcome (opt-in).
        recordOptOutcome(true);

        yield { type: 'stop', reason: response.stop_reason || 'end_turn' };
    }

    return { run, state, persist: () => sessionManager?.save(state) };
}

function detectProvider(model) {
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
    if (model.startsWith('gemini')) return 'google';
    return 'anthropic';
}

async function callApi(provider, model, state, toolDefs, settings) {
    const callers = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle };
    const caller = callers[provider] || callers.anthropic;
    return caller(model, state, toolDefs, settings, false);
}

async function callApiStreaming(provider, model, state, toolDefs, settings) {
    const callers = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle };
    const caller = callers[provider] || callers.anthropic;
    return caller(model, state, toolDefs, settings, true);
}

/**
 * Zoo-native Anthropic Messages client.
 * Honors ANTHROPIC_BASE_URL. Auth is Bearer (subscription / AUTH_TOKEN / sk-openzoo).
 * Never requires ANTHROPIC_API_KEY. Never POSTs to api.anthropic.com.
 */
export async function callAnthropic(model, state, toolDefs, settings, stream, deps = {}) {
    const fetchImpl = deps.fetch || globalThis.fetch;
    const env = deps.env || process.env;
    delete env.ANTHROPIC_API_KEY;

    const base = env.ANTHROPIC_BASE_URL || ZOO_LOCAL_BASE;
    const url = messagesUrl(base);
    const { headers } = anthropicHeaders(env);

    let apiModel = model;
    if (!apiModel || isAutoModel(apiModel)) apiModel = 'openzoo/auto';

    state.messages = sanitizePoisonedHistory(state.messages, state);

    const body = {
        model: apiModel,
        max_tokens: settings.maxTokens || 16384,
        messages: state.messages,
        ...(state.systemPrompt && { system: state.systemPrompt }),
        ...(toolDefs.length > 0 && { tools: toolDefs }),
        ...(stream && { stream: true }),
    };

    // Thinking only if the user asked — never model.includes('opus') (zoo catalog ids).
    if (shouldEnableThinking(apiModel, { ...settings, _thinking: state._thinking }, env)) {
        body.thinking = { type: 'enabled', budget_tokens: settings.thinkingBudget || 10000 };
    }

    const bindAt = state._spillHud ? (state._spillHud.sessionMultiple() == null || state._spillHud.sessionMultiple() < 5 ? 2000 : 16000) : 2000;
    headers['x-openzoo-bind-tokens'] = String(bindAt);

    const postOnce = () => fetchRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    }, { fetch: fetchImpl });

    let res = await postOnce();

    if (res.status === 402) {
        const err = await res.text();
        throw paymentErrorFromResponse(402, err);
    }

    if (!res.ok) {
        const err = await res.text();
        if (isPoisonHttp400(res.status, err)) {
            state.messages = sanitizePoisonedHistory(state.messages, state);
            body.messages = state.messages;
            res = await postOnce();
            if (res.status === 402) {
                const pay = await res.text();
                throw paymentErrorFromResponse(402, pay);
            }
            if (!res.ok) {
                const again = await res.text();
                throw new Error(`OpenZoo API error ${res.status}: ${again}`);
            }
        } else {
            throw new Error(`OpenZoo API error ${res.status}: ${err}`);
        }
    }

    if (state._spillHud) {
        const sent = JSON.stringify(body).length;
        state._spillHud.note(res.headers, sent);
    }

    if (stream) {
        const collected = [];
        const eventGenerator = async function* () {
            for await (const event of streamResponse(res)) {
                collected.push(event);
                yield event;
            }
        };
        return {
            events: eventGenerator(),
            get accumulated() {
                return accumulateFromCollected(collected);
            },
        };
    }

    return res.json();
}

async function callOpenAI(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const tools = toolDefs.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const buildBody = () => {
        state.messages = sanitizePoisonedHistory(state.messages, state);
        return {
            model,
            messages: openaiMessagesFromState(state),
            ...(tools.length > 0 && { tools }),
        };
    };

    let body = buildBody();
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const postOpenAI = (payload) => fetchRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    let res = await postOpenAI(body);

    if (!res.ok) {
        const err = await res.text();
        if (isPoisonHttp400(res.status, err)) {
            body = buildBody();
            res = await postOpenAI(body);
            if (!res.ok) {
                const again = await res.text();
                throw new Error(`OpenAI API error ${res.status}: ${again}`);
            }
        } else {
            throw new Error(`OpenAI API error ${res.status}: ${err}`);
        }
    }

    const data = await res.json();
    return convertOpenAIResponse(data);
}

function openaiMessagesFromState(state) {
    const messages = [];
    if (state.systemPrompt) {
        messages.push({ role: 'system', content: state.systemPrompt });
    }
    for (const msg of state.messages || []) {
        if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
            continue;
        }
        if (!Array.isArray(msg.content)) continue;
        if (msg.role === 'assistant') {
            const tool_calls = [];
            const texts = [];
            for (const block of msg.content) {
                if (block?.type === 'text' && block.text) texts.push(block.text);
                if (block?.type === 'tool_use' && block.id) {
                    tool_calls.push({
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
                    });
                }
            }
            const out = { role: 'assistant', content: texts.join('\n') || null };
            if (tool_calls.length) out.tool_calls = tool_calls;
            messages.push(out);
        } else if (msg.role === 'user') {
            const texts = [];
            for (const block of msg.content) {
                if (block?.type === 'text' && block.text) texts.push(block.text);
                if (typeof block === 'string') texts.push(block);
            }
            if (texts.length) messages.push({ role: 'user', content: texts.join('\n') });
            for (const block of msg.content) {
                if (block?.type === 'tool_result') {
                    messages.push({
                        role: 'tool',
                        tool_call_id: block.tool_use_id,
                        content: block.content,
                    });
                }
            }
        }
    }
    return messages;
}

async function callGoogle(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY not set');

    state.messages = sanitizePoisonedHistory(state.messages, state);

    const buildContents = () => {
        state.messages = sanitizePoisonedHistory(state.messages, state);
        const contents = [];
        for (const msg of state.messages) {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            if (typeof msg.content === 'string') {
                contents.push({ role, parts: [{ text: msg.content }] });
            } else if (Array.isArray(msg.content)) {
                const texts = msg.content
                    .map((b) => (typeof b === 'string' ? b : (b?.type === 'text' ? b.text : '')))
                    .filter(Boolean);
                if (texts.length) contents.push({ role, parts: [{ text: texts.join('\n') }] });
            }
        }
        return contents;
    };

    const body = {
        contents: buildContents(),
        ...(state.systemPrompt && {
            systemInstruction: { parts: [{ text: state.systemPrompt }] },
        }),
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const postGoogle = (payload) => fetchRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    let res = await postGoogle(body);

    if (!res.ok) {
        const err = await res.text();
        if (isPoisonHttp400(res.status, err)) {
            body.contents = buildContents();
            res = await postGoogle(body);
            if (!res.ok) {
                const again = await res.text();
                throw new Error(`Google API error ${res.status}: ${again}`);
            }
        } else {
            throw new Error(`Google API error ${res.status}: ${err}`);
        }
    }

    const data = await res.json();
    return convertGoogleResponse(data);
}

function convertOpenAIResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No choices in OpenAI response');

    const content = [];
    if (choice.message?.content) {
        content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments || '{}'),
            });
        }
    }

    return {
        content,
        stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason,
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
        },
    };
}

function convertGoogleResponse(data) {
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No candidates in Google response');

    const content = [];
    for (const part of candidate.content?.parts || []) {
        if (part.text) content.push({ type: 'text', text: part.text });
    }

    return {
        content,
        stop_reason: 'end_turn',
        usage: {
            input_tokens: data.usageMetadata?.promptTokenCount || 0,
            output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        },
    };
}

function accumulateFromCollected(events) {
    const message = {
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
    };

    let currentBlock = null;

    for (const event of events) {
        switch (event.type) {
            case 'message_start':
                if (event.message?.usage) {
                    message.usage.input_tokens = event.message.usage.input_tokens || 0;
                }
                break;
            case 'content_block_start':
                currentBlock = { ...event.content_block };
                if (currentBlock.type === 'text') currentBlock.text = '';
                if (currentBlock.type === 'thinking') currentBlock.thinking = '';
                if (currentBlock.type === 'tool_use') currentBlock.input = '';
                message.content.push(currentBlock);
                break;
            case 'content_block_delta':
                if (!currentBlock) break;
                if (event.delta?.type === 'text_delta') currentBlock.text += event.delta.text;
                else if (event.delta?.type === 'thinking_delta') currentBlock.thinking += event.delta.thinking;
                else if (event.delta?.type === 'input_json_delta') currentBlock.input += event.delta.partial_json;
                break;
            case 'content_block_stop':
                if (currentBlock?.type === 'tool_use' && typeof currentBlock.input === 'string') {
                    try { currentBlock.input = JSON.parse(currentBlock.input || '{}'); } catch { currentBlock.input = {}; }
                }
                currentBlock = null;
                break;
            case 'message_delta':
                if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
                if (event.usage) message.usage.output_tokens = event.usage.output_tokens || 0;
                break;
            case 'ping':
                break;
        }
    }

    return message;
}
