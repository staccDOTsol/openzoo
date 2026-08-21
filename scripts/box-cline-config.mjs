#!/usr/bin/env node
// Write Cline 4.x file-backed settings so the baked extension talks to OpenZoo.
//
// Cline 4.1.11 (saoudrizwan.claude-dev) has empty contributes.configuration —
// there are no VS Code settings.json keys. Official storage (cline/cline
// .clinerules/storage.md) is ~/.cline/data/{globalState,secrets}.json.
// Keys come from apps/vscode/src/shared/storage/state-keys.ts:
//   anthropicBaseUrl, planModeApiProvider, actModeApiProvider,
//   planModeApiModelId, actModeApiModelId, openAiBaseUrl
//   secrets: apiKey (Anthropic), openAiApiKey (OpenAI-compat)
//
// Never logs tokens. Never writes ANTHROPIC_API_KEY. Never ships a house key.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const CLINE_KEYS = Object.freeze({
  anthropicBaseUrl: 'anthropicBaseUrl',
  openAiBaseUrl: 'openAiBaseUrl',
  planModeApiProvider: 'planModeApiProvider',
  actModeApiProvider: 'actModeApiProvider',
  planModeApiModelId: 'planModeApiModelId',
  actModeApiModelId: 'actModeApiModelId',
  welcomeViewCompleted: 'welcomeViewCompleted',
  isNewUser: 'isNewUser',
  apiKey: 'apiKey',
  openAiApiKey: 'openAiApiKey',
});

export function zooOrigin(env = process.env) {
  const raw = String(env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev').trim();
  return raw.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function zooCompletionsUrl(env = process.env) {
  return `${zooOrigin(env)}/v1`;
}

export function subscriptionToken(env = process.env) {
  const keys = ['ANTHROPIC_AUTH_TOKEN', 'OPENZOO_SUB_KEY', 'OPENZOO_SUBSCRIPTION_KEY'];
  for (const k of keys) {
    const v = String(env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

export function clineModelId(env = process.env) {
  const raw = String(env.OPENZOO_MODEL || 'claude-sonnet-5').trim();
  return raw.replace(/^anthropic\//, '') || 'claude-sonnet-5';
}

export function clineGlobalState(env = process.env, existing = {}) {
  const origin = zooOrigin(env);
  const completions = zooCompletionsUrl(env);
  const model = clineModelId(env);
  return {
    ...existing,
    [CLINE_KEYS.anthropicBaseUrl]: origin,
    [CLINE_KEYS.openAiBaseUrl]: completions,
    [CLINE_KEYS.planModeApiProvider]: 'anthropic',
    [CLINE_KEYS.actModeApiProvider]: 'anthropic',
    [CLINE_KEYS.planModeApiModelId]: model,
    [CLINE_KEYS.actModeApiModelId]: model,
    [CLINE_KEYS.welcomeViewCompleted]: true,
    [CLINE_KEYS.isNewUser]: false,
  };
}

export function clineSecrets(env = process.env, existing = {}) {
  const token = subscriptionToken(env);
  const next = { ...existing };
  delete next.ANTHROPIC_API_KEY;
  if (token) {
    next[CLINE_KEYS.apiKey] = token;
    next[CLINE_KEYS.openAiApiKey] = token;
  }
  return next;
}

export function clineProviders(env = process.env, token = subscriptionToken(env)) {
  const settings = {
    provider: 'anthropic',
    model: clineModelId(env),
    baseUrl: zooOrigin(env),
  };
  if (token) settings.apiKey = token;
  return {
    version: 1,
    lastUsedProvider: 'anthropic',
    providers: {
      anthropic: {
        settings,
        tokenSource: 'manual',
      },
    },
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonAtomic(file, obj, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode });
  renameSync(tmp, file);
}

export function writeClineConfig({ home = process.env.HOME || homedir(), env = process.env } = {}) {
  const data = join(home, '.cline', 'data');
  const globalFile = join(data, 'globalState.json');
  const secretsFile = join(data, 'secrets.json');
  const providersFile = join(data, 'settings', 'providers.json');

  const globalState = clineGlobalState(env, readJson(globalFile));
  const secrets = clineSecrets(env, readJson(secretsFile));
  const providers = clineProviders(env, subscriptionToken(env));

  writeJsonAtomic(globalFile, globalState, 0o644);
  writeJsonAtomic(secretsFile, secrets, 0o600);
  writeJsonAtomic(providersFile, providers, 0o600);

  return { data, hasToken: Boolean(subscriptionToken(env)) };
}

const invoked = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const { hasToken } = writeClineConfig();
  // Never print tokens or base-URL query strings. Status only.
  console.log(hasToken ? 'cline settings written (token present)' : 'cline settings written (no token)');
}
