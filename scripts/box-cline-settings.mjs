#!/usr/bin/env node
// Write Cline's file-backed settings from box env. Called at boot, never at bake.
//
// Cline 4.x (VS Code / code-server / CLI) reads ~/.cline/data/globalState.json
// and ~/.cline/data/secrets.json (mode 0600). File store wins over VS Code
// migration, so seeding these before code-server starts is the configuration.
//
// Pay is the OpenZoo subscription Bearer. Never ANTHROPIC_API_KEY — that key
// bills api.anthropic.com. Never bake a literal token into the image.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLINE_EXT_ID = 'saoudrizwan.claude-dev';
export const DEFAULT_API_BASE = 'https://x402-tokens.fly.dev';

export function asKey(v) {
  return String(v ?? '').trim();
}

/** Subscription Bearer: ANTHROPIC_AUTH_TOKEN or OPENZOO_SUB_KEY (or the longer OPENZOO_SUBSCRIPTION_KEY). */
export function subscriptionToken(env = process.env) {
  return asKey(env.ANTHROPIC_AUTH_TOKEN)
    || asKey(env.OPENZOO_SUB_KEY)
    || asKey(env.OPENZOO_SUBSCRIPTION_KEY);
}

/** Anthropic-compatible door: $OPENZOO_API_BASE/v1 (no double /v1). */
export function clineBaseUrl(env = process.env) {
  const raw = asKey(env.OPENZOO_API_BASE) || DEFAULT_API_BASE;
  const base = raw.replace(/\/+$/, '');
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

export function clineModelId(env = process.env) {
  return asKey(env.OPENZOO_MODEL) || 'anthropic/claude-sonnet-5';
}

/** code-server password: CODE_SERVER_PASSWORD or sha256(sub key). Empty if neither. */
export function codeServerPassword(env = process.env) {
  const explicit = asKey(env.CODE_SERVER_PASSWORD);
  if (explicit) return explicit;
  const token = subscriptionToken(env);
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex');
}

function readJson(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function atomicWrite(file, data, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

export function clineDataDir(home = process.env.HOME || homedir()) {
  return join(home, '.cline', 'data');
}

/**
 * Merge OpenZoo provider + token into Cline's on-disk stores.
 * Does not write ANTHROPIC_API_KEY anywhere. Does not invent a token.
 */
export function writeClineOpenZooSettings({
  home = process.env.HOME || homedir(),
  env = process.env,
} = {}) {
  const token = subscriptionToken(env);
  const baseUrl = clineBaseUrl(env);
  const model = clineModelId(env);
  const dir = clineDataDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const globalPath = join(dir, 'globalState.json');
  const secretsPath = join(dir, 'secrets.json');
  const globalState = readJson(globalPath);
  const secrets = readJson(secretsPath);

  Object.assign(globalState, {
    apiProvider: 'anthropic',
    planModeApiProvider: 'anthropic',
    actModeApiProvider: 'anthropic',
    anthropicBaseUrl: baseUrl,
    planModeApiModelId: model,
    actModeApiModelId: model,
    welcomeViewCompleted: true,
    isNewUser: false,
    telemetrySetting: 'off',
    mode: 'act',
    __vscodeMigrationVersion: 1,
  });
  delete globalState.ANTHROPIC_API_KEY;
  delete globalState.anthropicApiKey;

  if (token) secrets.apiKey = token;
  delete secrets.ANTHROPIC_API_KEY;

  atomicWrite(globalPath, globalState, 0o600);
  atomicWrite(secretsPath, secrets, 0o600);

  const userDir = join(home, '.local', 'share', 'code-server', 'User');
  mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const settingsPath = join(userDir, 'settings.json');
  const settings = readJson(settingsPath);
  Object.assign(settings, {
    'workbench.startupEditor': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'security.workspace.trust.enabled': false,
    'window.restoreWindows': 'none',
  });
  delete settings['cline.apiKey'];
  delete settings.ANTHROPIC_API_KEY;
  atomicWrite(settingsPath, settings, 0o644);

  return {
    ok: true,
    extId: CLINE_EXT_ID,
    baseUrl,
    model,
    hasToken: Boolean(token),
    globalPath,
    secretsPath,
  };
}

/** YAML config for code-server. Password is quoted; never auth=none. */
export function writeCodeServerAuth({
  home = process.env.HOME || homedir(),
  env = process.env,
  bindAddr = '127.0.0.1:8081',
  password = '',
} = {}) {
  let source = 'explicit';
  let pass = asKey(password) || asKey(env.CODE_SERVER_PASSWORD);
  if (asKey(env.CODE_SERVER_PASSWORD) && !asKey(password)) source = 'CODE_SERVER_PASSWORD';
  if (!pass) {
    const token = subscriptionToken(env);
    if (token) {
      pass = createHash('sha256').update(token).digest('hex');
      source = 'sub-key-hash';
    }
  }
  if (!pass) {
    pass = randomBytes(16).toString('hex');
    source = 'generated';
  }
  const dir = join(home, '.config', 'code-server');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const yaml = [
    `bind-addr: ${bindAddr}`,
    'auth: password',
    `password: ${JSON.stringify(pass)}`,
    'cert: false',
    '',
  ].join('\n');
  const file = join(dir, 'config.yaml');
  writeFileSync(file, yaml, { mode: 0o600 });
  chmodSync(file, 0o600);
  const passFile = join(dir, 'password');
  writeFileSync(passFile, pass, { mode: 0o600 });
  chmodSync(passFile, 0o600);
  return { file, passFile, source, password: pass };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cline = writeClineOpenZooSettings();
  const auth = writeCodeServerAuth();
  console.log(JSON.stringify({
    ok: cline.ok,
    extId: cline.extId,
    baseUrl: cline.baseUrl,
    model: cline.model,
    hasToken: cline.hasToken,
    authSource: auth.source,
  }));
}
