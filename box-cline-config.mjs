#!/usr/bin/env node
// Seed Cline (saoudrizwan.claude-dev) so a subscriber opens the sidebar with
// Anthropic-compatible OpenZoo, never api.anthropic.com and never a stock
// Anthropic key.
//
// Cline 4.x package.json contributes.configuration.properties is empty —
// settings live in ~/.cline/data (globalState.json + secrets.json) and
// ~/.cline/data/settings/providers.json. After install we still honor any
// real claude-dev.* / cline.* keys from the baked package.json; we do not
// invent fake ones.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const HOME = process.env.HOME || homedir();
const GATEWAY = String(process.env.ANTHROPIC_BASE_URL || 'https://x402-tokens.fly.dev/v1').replace(/\/+$/, '');
const USER_DATA = process.env.CODE_SERVER_USER_DATA
  || join(HOME, '.local', 'share', 'code-server');
const KEYS_FILE = process.env.CLINE_CONFIG_KEYS
  || '/opt/code-server/cline-config-keys.json';
const NOW = new Date().toISOString();

// Cline's Anthropic SDK posts `{baseUrl}/v1/messages`. The OpenZoo gateway
// only serves POST /v1/messages, so a /v1 suffix becomes /v1/v1/messages.
function anthropicOrigin(url) {
  const stripped = String(url || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  return stripped || 'https://x402-tokens.fly.dev';
}

const ANTHROPIC_ORIGIN = anthropicOrigin(GATEWAY);

function subKey(env = process.env) {
  for (const name of ['OPENZOO_SUB_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENZOO_SUBSCRIPTION_KEY']) {
    const v = String(env[name] || '').trim();
    if (v) return v;
  }
  return '';
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
}

function loadDiscoveredKeys() {
  const baked = readJson(KEYS_FILE, null);
  if (baked && Array.isArray(baked.configurationKeys)) return baked;
  return { id: 'saoudrizwan.claude-dev', version: null, configurationKeys: [] };
}

function applyDiscoveredSettings(settings, keys, token, { origin = ANTHROPIC_ORIGIN, openaiBase = GATEWAY } = {}) {
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    if (/apiProvider/i.test(key)) settings[key] = 'anthropic';
    else if (/openAiBaseUrl/i.test(key)) settings[key] = openaiBase;
    else if (/anthropicBaseUrl/i.test(key) || /(^|\.)baseUrl$/i.test(key)) settings[key] = origin;
    else if (/(^|\.)apiKey$/i.test(key) && token) settings[key] = token;
  }
  return settings;
}

export function clineConfigPaths(env = process.env, home = HOME) {
  const data = join(env.CLINE_DATA_DIR || join(home, '.cline', 'data'));
  const userData = env.CODE_SERVER_USER_DATA || join(home, '.local', 'share', 'code-server');
  return {
    dataDir: data,
    globalState: join(data, 'globalState.json'),
    secrets: join(data, 'secrets.json'),
    providers: join(data, 'settings', 'providers.json'),
    userSettings: join(userData, 'User', 'settings.json'),
  };
}

export function buildClineFiles({ token, gateway = GATEWAY, discovered = loadDiscoveredKeys(), existing = {} } = {}) {
  const origin = anthropicOrigin(gateway);
  const globalState = {
    ...(existing.globalState && typeof existing.globalState === 'object' ? existing.globalState : {}),
    planModeApiProvider: 'anthropic',
    actModeApiProvider: 'anthropic',
    anthropicBaseUrl: origin,
    welcomeViewCompleted: true,
    isNewUser: false,
  };
  const secrets = {
    ...(existing.secrets && typeof existing.secrets === 'object' ? existing.secrets : {}),
  };
  if (token) secrets.apiKey = token;
  delete secrets.anthropicApiKey;

  const providers = {
    version: 1,
    lastUsedProvider: 'anthropic',
    modes: (existing.providers && existing.providers.modes) || {},
    providers: {
      ...((existing.providers && existing.providers.providers) || {}),
      anthropic: {
        settings: {
          provider: 'anthropic',
          protocol: 'anthropic',
          baseUrl: origin,
          ...(token ? { apiKey: token } : {}),
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
        updatedAt: NOW,
        tokenSource: 'manual',
      },
    },
  };

  const userSettings = {
    ...(existing.userSettings && typeof existing.userSettings === 'object' ? existing.userSettings : {}),
    'workbench.startupEditor': 'none',
    'workbench.activityBar.location': 'hidden',
    'workbench.sideBar.location': 'left',
    'workbench.editor.showTabs': 'none',
    'workbench.statusBar.visible': false,
    'workbench.layoutControl.enabled': false,
    'window.menuBarVisibility': 'hidden',
    'window.commandCenter': false,
    'editor.minimap.enabled': false,
    'breadcrumbs.enabled': false,
    'editor.fontSize': 16,
    'terminal.integrated.fontSize': 16,
    'editor.lineHeight': 24,
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
  };
  applyDiscoveredSettings(userSettings, discovered.configurationKeys || [], token, { origin, openaiBase: gateway });

  return { globalState, secrets, providers, userSettings, discovered };
}

function main() {
  if (String(process.env.ANTHROPIC_BASE_URL || '').includes('api.anthropic.com')) {
    console.error('[box-cline-config] refusing api.anthropic.com as ANTHROPIC_BASE_URL');
    process.exit(2);
  }
  const token = subKey();
  const paths = clineConfigPaths();
  const discovered = loadDiscoveredKeys();
  const files = buildClineFiles({
    token,
    gateway: GATEWAY,
    discovered,
    existing: {
      globalState: readJson(paths.globalState, {}),
      secrets: readJson(paths.secrets, {}),
      providers: readJson(paths.providers, {}),
      userSettings: readJson(paths.userSettings, {}),
    },
  });

  writeJson(paths.globalState, files.globalState);
  writeJson(paths.secrets, files.secrets, 0o600);
  writeJson(paths.providers, files.providers, 0o600);
  writeJson(paths.userSettings, files.userSettings);

  const n = (files.discovered.configurationKeys || []).length;
  process.stdout.write(
    `[box-cline-config] Cline ${files.discovered.id || 'saoudrizwan.claude-dev'}`
    + ` ${files.discovered.version || ''} keys=${n}`
    + ` gateway=${GATEWAY} secret=${token ? 'set' : 'missing'}\n`,
  );
  process.stdout.write(`[box-cline-config] ${paths.globalState}\n`);
  process.stdout.write(`[box-cline-config] ${paths.secrets}\n`);
  process.stdout.write(`[box-cline-config] ${paths.providers}\n`);
  process.stdout.write(`[box-cline-config] ${paths.userSettings}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
