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
 *
 * RE-MEASURED on OpenClaw 2026.8.2 (2026-09-02): the block this writes still
 * validates (`openclaw config validate` accepts baseUrl/apiKey/api/models with
 * cost/contextWindow/maxTokens), and a hand-added provider still gets no live
 * discovery — 2026.8's "live model discovery" is provider-plugin-owned. The
 * bundled `extensions/openzoo` provider plugin (upstream PR) is the proper
 * 2026.8+ path: discovery + pricing from /v1/models, no config surgery. This
 * command stays for older builds and for pinning an exact model list.
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
  // REPAIR WIZARD-CREATED ZOO PROVIDERS TOO. OpenClaw's own Custom Provider
  // flow points at the zoo but ignores what /v1/models says: cost is
  // hard-coded $0.00 and contextWindow defaults to 128k — measured
  // 2026-08-24 on a `custom-x402-tokens-fly-dev` provider whose status line
  // read "0/128k" while every zoo model is client-usable to 128M via spill.
  // Any OTHER provider whose baseUrl is a zoo endpoint gets its model rows
  // fixed in place (window always; cost only when the id is in our entries).
  const ZOO_BASE_RE = /localhost:8402|127\.0\.0\.1:8402|x402-tokens\.fly\.dev|api\.openzoo\.fun/i;
  const repaired = [];
  const costById = new Map(entries.map((e) => [e.id, e.cost]));
  for (const [name, prov] of Object.entries(cfg.models.providers)) {
    if (name === PROVIDER_KEY || !prov || typeof prov !== 'object') continue;
    if (!ZOO_BASE_RE.test(String(prov.baseUrl || ''))) continue;
    for (const m of Array.isArray(prov.models) ? prov.models : []) {
      let touched = false;
      if (Number(m.contextWindow) < 128_000_000) { m.contextWindow = 128_000_000; touched = true; }
      const bare = String(m.id || '').replace(/^openzoo[-/]/i, '');
      const cost = costById.get(m.id) || costById.get(bare);
      if (cost && (!m.cost || (!m.cost.input && !m.cost.output))) { m.cost = { ...cost }; touched = true; }
      if (touched) repaired.push(`${name}/${m.id}`);
    }
  }
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
  return { cfg, changedDefault, repaired };
}

async function fetchCatalogRows() {
  const r = await fetchHeaders(`${config.apiBase}/v1/models`);
  if (!r.ok) throw new Error(`model catalog fetch failed: HTTP ${r.status}`);
  const d = await r.json();
  // AUTO STAYS IN THE CATALOG. It used to be stripped here, which made it
  // unreachable by EVERY route — `--models openzoo/auto` failed with "not in
  // the live catalog", and OpenClaw refused a hand-edited config with
  // `model not allowed: openzoo/auto`. The price objection below is about the
  // cost BLOCK, and the answer to that is to quote a ceiling, not to delete
  // the router we tell people to use.
  return quoteableRows(d.data);
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
  // Same flagship picker Claude Code gets, WITH Auto pinned first.
  //
  // Auto's price genuinely varies per route, so no fixed cost block is exact.
  // But omitting it entirely is the worse lie: it tells the harness the router
  // does not exist. The command already prints "prices are the CEILING
  // (openrouter-direct)" over every row it writes, and a ceiling is precisely
  // what an upper bound across the picked set is — see the cost fix-up in
  // setupOpenClaw.
  const picked = pickClaudePickerRows(rows);
  const withoutAuto = picked.filter((m) => !isAutoModel(m.id));
  // PREFER THE BARE `auto` ID. The catalog offers `auto`, `openzoo/auto` and
  // `openzoo-auto` for the same router. OpenClaw renders a model as
  // `<provider>/<id>` and our provider key is already `openzoo`, so taking the
  // prefixed row writes `openzoo/openzoo/auto` — which is not the string the
  // user types and OpenClaw rejects it as "model not allowed".
  const autos = rows.filter((m) => isAutoModel(m.id));
  const auto = autos.find((m) => m.id === "auto") ?? autos[0];
  const ordered = auto ? [auto, ...withoutAuto] : withoutAuto;
  return ordered.length ? ordered : rows.slice(0, 8);
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
  // AUTO IS PRICED AT THE CEILING OF WHAT IT CAN ROUTE TO. Its own catalog row
  // carries no usable price (the route is chosen per request), and a zero there
  // reads to a budgeting harness as "free", which is the one number guaranteed
  // wrong. The max across everything written alongside it cannot be exceeded by
  // any route Auto picks from that set, so it over-states and never under-states.
  const autoEntry = entries.find((e) => isAutoModel(e.id));
  if (autoEntry) {
    const others = entries.filter((e) => e !== autoEntry);
    const ceil = (k) => others.reduce((m, e) => Math.max(m, Number(e.cost?.[k]) || 0), 0);
    autoEntry.cost = { input: ceil("input"), output: ceil("output"), cacheRead: 0, cacheWrite: 0 };
  }
  // Auto is written first, so it is also the default unless overridden.
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

  const { cfg, changedDefault, repaired } = mergeOpenClawConfig(existing, {
    port: config.port,
    entries,
    defaultId,
    forceDefault: Boolean(opt.defaultId),
  });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);

  console.log(`wrote ${entries.length} zoo model(s) with real ceiling prices into ${file}`);
  for (const r of repaired || []) {
    console.log(`  repaired wizard-created zoo provider entry: ${r} (contextWindow -> 128M, cost when known)`);
  }
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
