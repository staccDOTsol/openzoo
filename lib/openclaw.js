/**
 * `npx openzoo openclaw` — write the zoo into OpenClaw's config WITH REAL
 * PRICES, because OpenClaw will never learn them from the wire.
 *
 * MEASURED, on OpenClaw 2026.7.1-2: its custom-provider discovery hard-codes
 * `cost: {input:0, output:0, ...}` (SELF_HOSTED_DEFAULT_COST in
 * provider-self-hosted-setup) and ignores both the OpenRouter-style `pricing`
 * field our /v1/models already serves and any per-response usage cost. Its
 * cost panel prices turns purely from the `cost` block in
 * ~/.openclaw/openclaw.json — so a hand-added provider shows $0.00 forever.
 * The OpenRouter pricing parser it DOES have (parseOpenRouterPricing,
 * value * 1e6 → USD per Mtok) is wired only to the first-party OpenRouter
 * provider. Hence this command: fetch the live catalog, convert
 * pricing.prompt/completion (USD/token) into OpenClaw's USD/Mtok `cost`
 * blocks, and merge the provider into the config file ourselves.
 *
 * The written numbers are the CEILING (openrouter-direct basis): the gateway
 * charges at most this, less with trailing volume and leCore context reuse.
 * A client-side estimate can only be honest-or-high; receipts on the proxy
 * console stay the ground truth.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { fetchHeaders } from './fetch.js';
import {
  quoteableRows, pickClaudePickerRows, displayNameFor, tokenPricePair, isAutoModel,
} from './models.js';

export const PROVIDER_KEY = 'openzoo';

/** ~/.openclaw/openclaw.json unless overridden (tests, ports of OpenClaw). */
export function openclawConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH
    || path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

/**
 * Reasoning flag only where the id says so unambiguously. A wrong `true`
 * makes OpenClaw send thinking parameters the model rejects; a wrong `false`
 * merely hides a toggle. Asymmetric costs → conservative test.
 */
export function isReasoningId(id) {
  return /(^|\/)o[134](-|$)|reasoner|thinking|qwq|(^|[/-])r1($|[.-])/i.test(String(id || ''));
}

/**
 * One catalog row → one OpenClaw model entry. Pricing arrives in USD per
 * token (OpenRouter units); OpenClaw's `cost` is USD per MILLION tokens —
 * same conversion its own OpenRouter parser does (value * 1e6).
 */
export function openclawModelEntry(row) {
  const [prompt, completion] = tokenPricePair(row?.pricing);
  const perM = (v) => (Number.isFinite(v) && v > 0 ? Number((v * 1e6).toFixed(6)) : 0);
  return {
    id: row.id,
    name: displayNameFor(row.id) || row.id,
    reasoning: isReasoningId(row.id),
    input: ['text'],
    // context_length is the CLIENT-USABLE ceiling (leCore auto-spill), which
    // is the honest number for a harness deciding whether to chunk.
    contextWindow: Number(row.context_length) > 0 ? Number(row.context_length) : 128000,
    maxTokens: 8192,
    cost: {
      input: perM(prompt),
      output: perM(completion),
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

/**
 * Merge the openzoo provider into an OpenClaw config object. Pure — takes and
 * returns plain objects, touches no disk. Other providers and every unrelated
 * key survive untouched; OUR provider block is replaced wholesale (it is
 * generated, and a stale half-merge would resurrect dead models or prices).
 * The agent default is only claimed when the user asked (`forceDefault`) or
 * no primary model is configured at all — never silently re-pointed.
 */
export function mergeOpenClawConfig(existing, { port, entries, defaultId, forceDefault } = {}) {
  const cfg = existing && typeof existing === 'object' ? existing : {};
  cfg.models = cfg.models && typeof cfg.models === 'object' ? cfg.models : {};
  cfg.models.providers = cfg.models.providers && typeof cfg.models.providers === 'object'
    ? cfg.models.providers : {};
  cfg.models.providers[PROVIDER_KEY] = {
    baseUrl: `http://localhost:${port}/v1`,
    apiKey: 'sk-openzoo', // any value: the zoo takes payment, not keys
    api: 'openai-completions',
    models: entries,
  };
  let changedDefault = false;
  const ref = defaultId ? `${PROVIDER_KEY}/${defaultId}` : null;
  if (ref) {
    cfg.agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
    cfg.agents.defaults = cfg.agents.defaults && typeof cfg.agents.defaults === 'object'
      ? cfg.agents.defaults : {};
    const model = cfg.agents.defaults.model && typeof cfg.agents.defaults.model === 'object'
      ? cfg.agents.defaults.model : {};
    if (forceDefault || !model.primary) {
      model.primary = ref;
      cfg.agents.defaults.model = model;
      changedDefault = true;
    }
  }
  return { cfg, changedDefault };
}

async function fetchCatalogRows() {
  const r = await fetchHeaders(`${config.apiBase}/v1/models`);
  if (!r.ok) throw new Error(`model catalog fetch failed: HTTP ${r.status}`);
  const d = await r.json();
  return quoteableRows(d.data).filter((m) => !isAutoModel(m.id));
}

function pickRows(rows, { all, wanted }) {
  if (wanted && wanted.length) {
    const byId = new Map(rows.map((m) => [m.id, m]));
    const missing = wanted.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new Error(`not in the live catalog: ${missing.join(', ')} (see: npx openzoo models)`);
    }
    return wanted.map((id) => byId.get(id));
  }
  if (all) return rows;
  // Short honest default: same flagship picker Claude Code gets, minus Auto
  // (Auto's price varies per route — a fixed cost block would be a lie).
  const picked = pickClaudePickerRows(rows).filter((m) => !isAutoModel(m.id));
  return picked.length ? picked : rows.slice(0, 8);
}

/**
 * `npx openzoo openclaw [--all | --models a,b] [--default <id>] [--config <path>]`
 */
export async function setupOpenClaw(argv = []) {
  const args = [...argv];
  const opt = { all: false, wanted: null, defaultId: null, configPath: null };
  while (args.length) {
    const a = args.shift();
    if (a === '--all') opt.all = true;
    else if (a === '--models') opt.wanted = String(args.shift() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--default') opt.defaultId = String(args.shift() || '').trim() || null;
    else if (a === '--config') opt.configPath = String(args.shift() || '').trim() || null;
    else throw new Error(`unknown flag: ${a}`);
  }

  const rows = pickRows(await fetchCatalogRows(), opt);
  if (!rows.length) throw new Error('live catalog returned no quoteable models');
  const entries = rows.map(openclawModelEntry);
  const defaultId = opt.defaultId || entries[0].id;
  if (!entries.some((e) => e.id === defaultId)) {
    throw new Error(`--default ${defaultId} is not among the written models (add it via --models)`);
  }

  const file = opt.configPath || openclawConfigPath();
  let existing = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      existing = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
      // OpenClaw itself writes strict JSON; a parse failure means the user
      // hand-edited (JSON5 comments etc.). Print the block instead of
      // corrupting their file — fail open with a usable result.
      console.error(`openzoo: could not parse ${file} (${e.message}).`);
      console.error('add this under models.providers yourself:\n');
      console.error(JSON.stringify({ [PROVIDER_KEY]: mergeOpenClawConfig({}, { port: config.port, entries, defaultId }).cfg.models.providers[PROVIDER_KEY] }, null, 2));
      process.exitCode = 1;
      return null;
    }
    fs.copyFileSync(file, `${file}.openzoo-backup`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const { cfg, changedDefault } = mergeOpenClawConfig(existing, {
    port: config.port,
    entries,
    defaultId,
    forceDefault: Boolean(opt.defaultId),
  });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);

  console.log(`wrote ${entries.length} zoo model(s) with real ceiling prices into ${file}`);
  for (const e of entries) {
    console.log(`  ${PROVIDER_KEY}/${e.id}  $${e.cost.input}/Mtok in, $${e.cost.output}/Mtok out`);
  }
  console.log(changedDefault
    ? `default model: ${PROVIDER_KEY}/${defaultId}`
    : `default model kept (${cfg.agents?.defaults?.model?.primary || 'unset'}); use --default <id> to switch`);
  console.log('prices are the CEILING (openrouter-direct): volume + context reuse only lower them;');
  console.log('receipts on the proxy console remain the ground truth.');
  console.log('\nnow: keep `npx openzoo` running, then `openclaw gateway restart`');
  return { file, entries, defaultId, changedDefault };
}
