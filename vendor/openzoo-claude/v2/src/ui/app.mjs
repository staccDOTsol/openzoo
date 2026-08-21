/**
 * Main Ink App — full React terminal UI matching Claude Code's interface.
 *
 * Uses React.createElement (no JSX transpiler needed).
 *
 * Features:
 * - Scrolling messages area with assistant, user, tool, thinking messages
 * - Persistent status bar (model, context%, cost, time, permission mode)
 * - Text input with prompt indicator
 * - Loading spinner during API calls
 * - Tool execution display with spinners
 * - Keyboard shortcuts (Escape, Ctrl+C, Ctrl+L)
 * - Slash command support (39 commands)
 * - Skill invocation via /skill-name
 */

import React, { useState, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import {
    StatusBar,
    Message,
    LoadingIndicator,
    WelcomeBanner,
} from './components.mjs';
import { executeCommand, COMMANDS } from './commands.mjs';
import { goalPrompt, setGoal } from '../core/goal.mjs';

const h = React.createElement;

/**
 * Main application component.
 */
export function App({ agentLoop, settings }) {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [model, setModel] = useState(agentLoop.state.model || 'claude-sonnet-4-6');
    const [tokenCount, setTokenCount] = useState({ input: 0, output: 0 });
    const [cost, setCost] = useState(0);
    const [mode] = useState(settings.permissions?.defaultMode || 'default');
    const [toolStatus, setToolStatus] = useState(null);
    const [startTime] = useState(Date.now());
    const loadingRef = useRef(false);
    const { exit } = useApp();

    // Calculate cost from token counts
    const updateCost = useCallback((tokens) => {
        const m = agentLoop.state.model || '';
        let priceIn = 3, priceOut = 15;
        if (m.includes('haiku')) { priceIn = 0.25; priceOut = 1.25; }
        if (m.includes('opus')) { priceIn = 15; priceOut = 75; }
        const costIn = (tokens.input / 1_000_000) * priceIn;
        const costOut = (tokens.output / 1_000_000) * priceOut;
        setCost(costIn + costOut);
    }, [agentLoop.state.model]);

    // Add a message to the display
    const addMessage = useCallback((msg) => {
        setMessages(prev => {
            const next = [...prev, msg];
            return next.length > 200 ? next.slice(-150) : next;
        });
    }, []);

    // Handle slash commands
    const handleCommand = useCallback((text) => {
        const cmdName = text.split(/\s+/)[0].toLowerCase();

        // Check for skill invocation
        if (!COMMANDS[cmdName] && agentLoop.state._skillsLoader) {
            const skill = agentLoop.state._skillsLoader.get(cmdName.slice(1));
            if (skill) {
                const args = text.slice(cmdName.length).trim();
                addMessage({ role: 'user', content: text });
                runPrompt(
                    `[Skill: ${skill.name}]\n${skill.prompt}${args ? `\nArguments: ${args}` : ''}`
                );
                return;
            }
        }

        if (cmdName === '/goal') {
            const args = text.slice(cmdName.length).trim();
            setGoal(agentLoop.state, args);
            if (args) {
                addMessage({ role: 'user', content: text });
                runPrompt(goalPrompt(args));
            } else {
                const { response } = executeCommand(text, agentLoop.state);
                addMessage({ role: 'system', content: response });
            }
            return;
        }

        const { response, exit: shouldExit } = executeCommand(text, agentLoop.state);
        if (shouldExit) {
            exit();
            return;
        }
        if (typeof response === 'string' && response.startsWith('__OZ_GOAL_RUN__')) {
            addMessage({ role: 'user', content: text });
            runPrompt(response.slice('__OZ_GOAL_RUN__'.length));
            return;
        }
        addMessage({ role: 'system', content: response });

        // Sync model if it changed
        if (agentLoop.state.model !== model) {
            setModel(agentLoop.state.model);
        }
    }, [agentLoop, model, addMessage, exit]);

    // Run a prompt through the agent loop
    const runPrompt = useCallback(async (text) => {
        setIsLoading(true);
        loadingRef.current = true;
        setToolStatus(null);

        try {
            for await (const event of agentLoop.run(text)) {
                switch (event.type) {
                    case 'stream_event':
                        setMessages(prev => {
                            const last = prev[prev.length - 1];
                            if (last && last.role === 'assistant' && last._streaming) {
                                return [
                                    ...prev.slice(0, -1),
                                    { ...last, content: (last.content || '') + (event.text || '') },
                                ];
                            }
                            return [
                                ...prev,
                                { role: 'assistant', content: event.text || '', _streaming: true },
                            ];
                        });
                        break;

                    case 'assistant':
                        setMessages(prev => {
                            const last = prev[prev.length - 1];
                            if (last && last.role === 'assistant' && last._streaming) {
                                return [
                                    ...prev.slice(0, -1),
                                    { ...last, _streaming: false },
                                ];
                            }
                            if (event.content) {
                                return [...prev, { role: 'assistant', content: event.content }];
                            }
                            return prev;
                        });
                        break;

                    case 'thinking':
                        addMessage({ role: 'thinking', thinking: event.text });
                        break;

                    case 'tool_progress':
                        setToolStatus(event.tool);
                        addMessage({
                            role: 'tool',
                            toolName: event.tool,
                            toolStatus: 'running',
                        });
                        break;

                    case 'result':
                        setToolStatus(null);
                        setMessages(prev => {
                            const idx = prev.findLastIndex(
                                m => m.role === 'tool' &&
                                     m.toolName === event.tool &&
                                     m.toolStatus === 'running'
                            );
                            if (idx >= 0) {
                                const updated = [...prev];
                                updated[idx] = {
                                    ...updated[idx],
                                    toolResult: typeof event.result === 'string'
                                        ? event.result
                                        : JSON.stringify(event.result),
                                    toolStatus: 'done',
                                };
                                return updated;
                            }
                            return prev;
                        });
                        break;

                    case 'compaction':
                        addMessage({ role: 'system', content: `[compaction #${event.count}]` });
                        break;

                    case 'hookPermissionResult':
                        if (!event.allowed) {
                            addMessage({ role: 'system', content: `[blocked: ${event.tool}]` });
                        }
                        break;

                    case 'error':
                        addMessage({ role: 'error', content: event.message });
                        break;

                    case 'stop':
                        break;
                }

                // Update token counts
                const usage = agentLoop.state.tokenUsage;
                setTokenCount({ input: usage.input, output: usage.output });
                updateCost(usage);
            }
        } catch (err) {
            addMessage({ role: 'error', content: err.message });
        } finally {
            setIsLoading(false);
            loadingRef.current = false;
            setToolStatus(null);
        }
    }, [agentLoop, addMessage, updateCost]);

    // Handle submit
    const handleSubmit = useCallback((value) => {
        const trimmed = value.trim();
        if (!trimmed) return;

        setInput('');

        if (trimmed.startsWith('/')) {
            handleCommand(trimmed);
            return;
        }

        addMessage({ role: 'user', content: trimmed });
        const session = agentLoop.state._sessionManager;
        if (session) session.save(agentLoop.state);
        runPrompt(trimmed);
    }, [handleCommand, addMessage, runPrompt]);

    // Keyboard shortcuts
    useInput((ch, key) => {
        if (key.escape && loadingRef.current) {
            setIsLoading(false);
            setToolStatus(null);
            addMessage({ role: 'system', content: '[cancelled]' });
        }
        if (key.ctrl && ch === 'c') {
            exit();
        }
        if (key.ctrl && ch === 'l') {
            setMessages([]);
        }
    });

    const toolCount = agentLoop.state.tools?.list?.()?.length || 0;

    // Build the message list
    const messageElements = messages.map((msg, i) =>
        h(Message, { key: i, ...msg })
    );

    return h(Box, { flexDirection: 'column' },
        // Welcome banner
        h(WelcomeBanner, { model, toolCount }),

        // Messages area
        h(Box, { flexDirection: 'column', flexGrow: 1 },
            ...messageElements,
            isLoading ? h(LoadingIndicator, { tool: toolStatus }) : null,
        ),

        // Input area
        h(Box, { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, marginTop: 1 },
            h(Text, { color: 'cyan' }, '> '),
            h(TextInput, {
                value: input,
                onChange: setInput,
                onSubmit: handleSubmit,
                placeholder: 'Type a message...',
            }),
        ),

        // Status bar
        h(StatusBar, {
            model,
            tokens: tokenCount,
            cost,
            mode,
            startTime,
            contextMax: settings.maxContextTokens || 200000,
            spillLabel: agentLoop.state._spillHud?.format?.() || '',
        }),
    );
}

/**
 * Start the Ink application.
 * @param {object} agentLoop - agent loop instance
 * @param {object} settings - loaded settings
 * @returns {object} Ink instance
 */
export function startInkApp(agentLoop, settings) {
    const instance = render(
        h(App, { agentLoop, settings })
    );
    return instance;
}
