/**
 * openzoo_claude — Paperclip external adapter.
 *
 * A full CLI harness: the built-in claude_local adapter (streaming JSONL,
 * session resume, skills, instructions bundle) with the environment
 * `openzoo claude` writes, so every inference call pays x402 through the
 * local OpenZoo proxy instead of billing api.anthropic.com.
 *
 * Env semantics mirror openzoo-shim/lib/launch.js claudeZooEnv:
 *  - ANTHROPIC_BASE_URL → the proxy (:8402/v1 by default)
 *  - ANTHROPIC_AUTH_TOKEN gateway auth, ANTHROPIC_API_KEY force-emptied
 *    (an inherited API key outranks ANTHROPIC_BASE_URL and silently bills
 *    Anthropic — observed, not theoretical)
 *  - gateway model discovery on, auto-compact off + context ceiling raised
 *    (the proxy binds the prefix and forwards a bounded tail)
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as claude from "@paperclipai/adapter-claude-local/server";
import { agentConfigurationDoc as claudeDoc } from "@paperclipai/adapter-claude-local";

const ADAPTER_TYPE = "openzoo_claude";
const DEFAULT_BASE = process.env.OPENZOO_BASE_URL || "http://localhost:8402/v1";

const asStr = (v, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
const asBool = (v, d = false) => (typeof v === "boolean" ? v : typeof v === "string" ? v === "true" || v === "1" : d);
function parseObj(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try { const p = JSON.parse(v); if (p && typeof p === "object" && !Array.isArray(p)) return p; } catch { /* not JSON */ }
  }
  return {};
}

function proxyBase(config) {
  return asStr(config?.proxyBase, DEFAULT_BASE).replace(/\/+$/, "");
}

/**
 * Bin dirs the claude CLI (and the `node` its shebang needs) actually live in.
 * The Paperclip server often runs as a service with a minimal PATH — without
 * this, runs die with `Command not found in PATH: "claude"` (CLI engine) or
 * `env: node: No such file or directory` (ACP engine). Mirrors
 * openzoo-shim/lib/launch.js claudeCodeBinDirs, plus the node running this
 * server and every nvm-installed node bin.
 */
function zooBinDirs() {
  const home = os.homedir();
  const dirs = [
    path.dirname(process.execPath),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  try {
    const nvm = path.join(home, ".nvm", "versions", "node");
    for (const v of fs.readdirSync(nvm)) dirs.push(path.join(nvm, v, "bin"));
  } catch { /* no nvm */ }
  return dirs.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

function zooPath(existing = process.env.PATH) {
  const parts = String(existing ?? "").split(path.delimiter).filter(Boolean);
  return [...new Set([...zooBinDirs(), ...parts])].join(path.delimiter);
}

/**
 * The REAL Claude Code binary vendored as a dependency of this package.
 * A `claude` found on the user's PATH may be a fork (observed: open-claude-code,
 * which hardcodes api.anthropic.com, requires ANTHROPIC_API_KEY, and speaks a
 * different stream-json dialect — three separate ways it can never route
 * through the zoo). The vendored binary is the harness this adapter is
 * actually tested against, so it is the default; config.command overrides.
 */
const requireFromHere = createRequire(import.meta.url);
let vendoredClaudeCache;
function vendoredClaude() {
  if (vendoredClaudeCache !== undefined) return vendoredClaudeCache;
  vendoredClaudeCache = null;
  try {
    const pkgPath = requireFromHere.resolve("@anthropic-ai/claude-code/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
    if (bin) {
      const candidate = path.join(path.dirname(pkgPath), bin);
      if (fs.existsSync(candidate)) vendoredClaudeCache = candidate;
    }
  } catch { /* dep missing — fall back to PATH lookup */ }
  return vendoredClaudeCache;
}

function zooEnv(config) {
  const env = {
    ANTHROPIC_BASE_URL: proxyBase(config),
    ANTHROPIC_AUTH_TOKEN: asStr(config?.gatewayToken, "sk-openzoo"),
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "",
  };
  if (!asBool(config?.keepCompact)) {
    env.DISABLE_COMPACT = "1";
    env.DISABLE_AUTO_COMPACT = "1";
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = asStr(config?.contextTokens, "1000000");
  }
  return env;
}

async function fetchJson(url, headers = {}, timeoutMs = 5000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Models — the proxy's Claude picker (anthropic-shaped short list), cached.
// ---------------------------------------------------------------------------
const FALLBACK_MODELS = [
  { id: "claude-opus-5", label: "claude-opus-5 (zoo)" },
  { id: "claude-fable-5", label: "claude-fable-5 (zoo)" },
  { id: "claude-sonnet-5", label: "claude-sonnet-5 (zoo)" },
  { id: "claude-opus-4-8", label: "claude-opus-4-8 (zoo)" },
];
let modelsCache = { at: 0, list: null };

async function fetchZooModels(config = {}) {
  const data = await fetchJson(`${proxyBase(config)}/models`, { "anthropic-version": "2023-06-01" });
  const rows = Array.isArray(data?.data) ? data.data : [];
  const list = rows
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({ id: m.id, label: m.display_name || m.id }));
  return list.length > 0 ? list : FALLBACK_MODELS;
}

async function listModels() {
  if (modelsCache.list && Date.now() - modelsCache.at < 5 * 60_000) return modelsCache.list;
  try {
    modelsCache = { at: Date.now(), list: await fetchZooModels() };
    return modelsCache.list;
  } catch {
    return modelsCache.list ?? FALLBACK_MODELS;
  }
}

async function refreshModels() {
  modelsCache = { at: 0, list: null };
  return listModels();
}

// ---------------------------------------------------------------------------
// Execute — delegate to claude_local with the zoo env merged into config.env.
// User-configured env keys win: overriding the base URL or token is a
// deliberate act, not an accident.
// ---------------------------------------------------------------------------
async function execute(ctx) {
  const config = ctx.config ?? {};
  const mergedEnv = { ...zooEnv(config), ...parseObj(config.env) };
  // PATH from config.env overrides the server's; only synthesize one when the
  // user hasn't set their own.
  if (!asStr(mergedEnv.PATH)) mergedEnv.PATH = zooPath();
  // The Claude CLI is the launch path proven to carry the zoo env end-to-end.
  // "auto" prefers ACP, and the UI form saves "auto" by default — so both
  // unset and "auto" mean CLI here. Only an explicit "acp" choice keeps ACP.
  const engine = asStr(config.engine) === "acp" ? "acp" : "cli";
  const command = asStr(config.command) || vendoredClaude() || "claude";
  const result = await claude.execute({ ...ctx, config: { ...config, engine, command, env: mergedEnv } });
  return {
    ...result,
    provider: "openzoo",
    biller: result.biller ?? "openzoo",
    billingType: "metered_api",
  };
}

// ---------------------------------------------------------------------------
// Environment test — proxy up, catalog visible, claude CLI resolvable.
// ---------------------------------------------------------------------------
function claudeVersion(command, env) {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { env, timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

async function testEnvironment(ctx) {
  const config = ctx?.config ?? {};
  const base = proxyBase(config);
  const checks = [];

  try {
    await fetchJson(`${base}/info`, {}, 3000);
    checks.push({ code: "openzoo_proxy", level: "info", message: `OpenZoo proxy reachable at ${base}` });
  } catch (err) {
    checks.push({
      code: "openzoo_proxy",
      level: "error",
      message: `OpenZoo proxy not reachable at ${base}`,
      detail: err instanceof Error ? err.message : String(err),
      hint: "Start it with `npx openzoo` (or `npx openzoo claude` once — it auto-starts the proxy). Override the URL with adapterConfig.proxyBase.",
    });
  }

  try {
    const models = await fetchZooModels(config);
    checks.push({ code: "openzoo_models", level: "info", message: `Zoo catalog publishes ${models.length} Claude-picker model(s)` });
  } catch (err) {
    checks.push({
      code: "openzoo_models",
      level: "warn",
      message: "Could not read the zoo model catalog (gateway upstream may be down)",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const command = asStr(config.command) || vendoredClaude() || "claude";
  const version = await claudeVersion(command, { ...process.env, PATH: zooPath() });
  if (version && /open-claude-code/i.test(version)) {
    checks.push({
      code: "claude_cli",
      level: "error",
      message: `"${command}" is open-claude-code (${version}), which cannot route through the zoo`,
      detail: "It hardcodes api.anthropic.com, requires ANTHROPIC_API_KEY, and speaks a different stream protocol.",
      hint: "Clear adapterConfig.command to use the real Claude Code vendored with this adapter, or point it at a real Claude Code binary.",
    });
  } else if (version) {
    checks.push({ code: "claude_cli", level: "info", message: `claude CLI found: ${version} (${vendoredClaude() === command ? "vendored" : command})` });
  } else {
    checks.push({
      code: "claude_cli",
      level: "error",
      message: `claude CLI not runnable at "${command}"`,
      hint: "Reinstall this adapter with an arm64 node on Apple Silicon (the @anthropic-ai/claude-code native binary is per-arch), or set adapterConfig.command to a working Claude Code binary. No Anthropic login needed — the adapter points ANTHROPIC_BASE_URL at the local proxy.",
    });
  }

  const status = checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass";
  return { adapterType: ADAPTER_TYPE, status, checks, testedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Config schema — claude_local's schema plus the openzoo knobs.
// ---------------------------------------------------------------------------
const OPENZOO_FIELDS = [
  {
    key: "proxyBase",
    label: "OpenZoo proxy base URL",
    type: "text",
    default: DEFAULT_BASE,
    hint: "The local x402-paying proxy. `npx openzoo` serves it on :8402.",
    group: "OpenZoo",
  },
  {
    key: "gatewayToken",
    label: "Gateway auth token",
    type: "text",
    default: "sk-openzoo",
    hint: "ANTHROPIC_AUTH_TOKEN sent to the proxy. Not an Anthropic API key — those are force-unset.",
    group: "OpenZoo",
  },
  {
    key: "keepCompact",
    label: "Keep Claude Code auto-compact",
    type: "toggle",
    default: false,
    hint: "Off by default: the proxy already binds the transcript prefix and forwards a bounded tail, so compaction only loses context.",
    group: "OpenZoo",
  },
  {
    key: "contextTokens",
    label: "Claude Code context ceiling",
    type: "text",
    default: "1000000",
    hint: "CLAUDE_CODE_MAX_CONTEXT_TOKENS when auto-compact is disabled.",
    group: "OpenZoo",
  },
];

async function getConfigSchema() {
  let fields = [];
  try {
    const schema = await claude.getConfigSchema();
    fields = Array.isArray(schema?.fields) ? schema.fields : [];
  } catch { /* claude schema unavailable — openzoo fields still render */ }
  fields = fields.map((f) => {
    if (f?.key !== "engine") return f;
    const options = Array.isArray(f.options)
      ? [...f.options].sort((a, b) => (a.value === "cli" ? -1 : b.value === "cli" ? 1 : 0))
      : f.options;
    return {
      ...f,
      default: "cli",
      options,
      hint: "Claude CLI is the launch path proven to carry the zoo env end-to-end. Auto prefers ACP.",
    };
  });
  return { fields: [...fields, ...OPENZOO_FIELDS] };
}

const agentConfigurationDoc = [
  `# ${ADAPTER_TYPE} agent configuration`,
  "",
  "Claude Code as the harness, OpenZoo as the biller: every inference call is",
  "paid x402 through the local proxy from a local burner wallet. No Anthropic",
  "login or API key — ANTHROPIC_API_KEY is force-unset because it would both",
  "outrank ANTHROPIC_BASE_URL and bill api.anthropic.com.",
  "",
  "OpenZoo fields:",
  "- proxyBase (string): proxy base URL, default " + DEFAULT_BASE,
  "- gatewayToken (string): ANTHROPIC_AUTH_TOKEN for the proxy, default sk-openzoo",
  "- keepCompact (bool): re-enable Claude Code auto-compact (default off)",
  "- contextTokens (string): CLAUDE_CODE_MAX_CONTEXT_TOKENS when compaction is off",
  "",
  "Everything else (model, cwd, promptTemplate, env, engine, skills,",
  "instructions bundle, timeouts) behaves exactly like claude_local.",
  "Models come from the zoo catalog (GET /v1/models on the proxy); vendor ids",
  "like anthropic/claude-opus-5 and harness aliases both resolve.",
  "",
  "Prerequisite: the proxy must be running — `npx openzoo` — and the burner",
  "wallet funded, or every call returns HTTP 402.",
  "",
  "---",
  "",
  claudeDoc ?? "",
].join("\n");

export function createServerAdapter() {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    listSkills: claude.listClaudeSkills,
    syncSkills: claude.syncClaudeSkills,
    sessionCodec: claude.sessionCodec,
    models: FALLBACK_MODELS,
    listModels,
    refreshModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec: (config) => {
      const command = asStr(config?.command) || vendoredClaude() || "claude";
      return {
        command,
        detectCommand: command,
        installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
      };
    },
    getConfigSchema,
    agentConfigurationDoc,
  };
}
