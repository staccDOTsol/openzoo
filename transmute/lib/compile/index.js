// The transmuter: VercelDeployment → Rust crate + manifest + report.
//
//   transmute(deployment, opts) → { crate: { 'Cargo.toml', 'src/lib.rs' }, manifest, report }
//   compileFunction(fn, source, opts) → { rust, ir, eligible, reason, ... }   (one Lambda, for tests/tools)
import fs from 'node:fs';
import path from 'node:path';
import { Ineligible, functionMetaReason, deploymentWarnings, displayFile } from '../eligibility.js';
import { readModule } from './parse.js';
import { lowerRoute } from './ir.js';
import { emitRoute, emitCrate, RustPrinter, DEFAULT_RUNTIME_PATH, sanitizeCrateName } from './rust.js';
import { emitModule } from './bytecode.js';

export { readModule, parseModule, stripTypes } from './parse.js';
export { lowerRoute, IR } from './ir.js';
export { emitRoute, emitCrate, RustPrinter, DEFAULT_RUNTIME_PATH, sanitizeCrateName, rustStr } from './rust.js';
export { emitModule, OP } from './bytecode.js';
export { Ineligible } from '../eligibility.js';

export const MANIFEST_VERSION = 1;

/**
 * Compile one Lambda.
 * @param {object} fn   VercelFunction-like: { name, routePath, pattern, params, style, sourceFile, methods }
 * @param {string} source  handler source text
 * @param {{ index?: number, file?: string }} opts
 */
export function compileFunction(fn, source, opts = {}) {
  const file = opts.file || fn.sourceFile || fn.name || 'handler.js';
  const index = opts.index ?? 0;
  const out = { name: fn.name, file, eligible: false, reason: null, line: null, rust: null, ir: null, kv: false, env: [], envDynamic: false, methods: null, style: null, warnings: [] };
  try {
    const meta = functionMetaReason(fn);
    if (meta) throw new Ineligible(meta, { file });
    const mod = readModule(source, { file });
    const lowered = lowerRoute(mod, fn, { index, file });
    out.ir = lowered.ir;
    out.kv = lowered.kv;
    out.env = lowered.env;
    out.envDynamic = lowered.envDynamic;
    out.methods = lowered.methods;
    out.style = lowered.style;
    out.warnings = lowered.warnings;
    out.rust = emitRoute(lowered.ir, { printer: opts.printer || new RustPrinter() });
    out.eligible = true;
  } catch (e) {
    if (e instanceof Ineligible) {
      out.reason = e.reason;
      out.line = e.line;
      out.file = e.file || file;
    } else {
      out.reason = `transmuter error: ${e.message}`;
      out.internalError = e;
    }
  }
  return out;
}

/**
 * Transmute a deployment.
 * @param {import('../vercel.js').VercelDeployment} deployment
 * @param {{ name?: string, runtimePath?: string, readSource?: (fn) => string }} opts
 */
export function transmute(deployment, opts = {}) {
  const name = sanitizeCrateName(opts.name || 'zoo_site');
  const runtimePath = path.resolve(opts.runtimePath || DEFAULT_RUNTIME_PATH);
  const readSource = opts.readSource || ((fn) => fs.readFileSync(fn.sourceFile, 'utf8'));
  const report = { eligible: [], ineligible: [], warnings: deploymentWarnings(deployment) };
  const routes = [];
  const routeSources = [];
  const loweredIrs = [];
  const mergedEnv = {};
  const referencedEnv = new Set();
  let envDynamic = false;
  const printer = new RustPrinter();

  for (const fn of deployment.functions || []) {
    const file = displayFile(fn, deployment.root);
    let source;
    try {
      const meta = functionMetaReason(fn);
      if (meta) throw new Ineligible(meta, { file });
      source = readSource(fn);
    } catch (e) {
      if (e instanceof Ineligible) { report.ineligible.push({ name: fn.name, reason: e.reason, file: e.file || file, line: e.line }); continue; }
      report.ineligible.push({ name: fn.name, reason: `cannot read source: ${e.message}`, file, line: null });
      continue;
    }
    const index = routes.length;
    // one shared printer keeps temp names unique across the crate
    const c = compileFunction(fn, source, { index, file, printer });
    for (const w of c.warnings) report.warnings.push(`${fn.name}: ${w}`);
    if (!c.eligible) {
      report.ineligible.push({ name: fn.name, reason: c.reason, file: c.file, line: c.line });
      if (c.internalError) report.warnings.push(`${fn.name}: ${c.internalError.stack?.split('\n').slice(0, 2).join(' ') || c.internalError.message}`);
      continue;
    }
    routeSources.push(c.rust);
    loweredIrs.push(c.ir);
    for (const k of c.env) referencedEnv.add(k);
    if (c.envDynamic) envDynamic = true;
    Object.assign(mergedEnv, fn.environment || {});
    report.eligible.push(fn.name);
    routes.push({
      index,
      name: fn.name,
      routePath: fn.routePath,
      pattern: fn.pattern,
      params: fn.params || [],
      methods: c.methods, // null = any method (Node-style handler); list = web-standard method exports
      style: fn.style || (c.style === 'node' ? 'pages' : 'app'),
      kv: c.kv,
    });
  }

  // Environment: only what handlers read, unless one reads process.env dynamically.
  const envNames = envDynamic ? Object.keys(mergedEnv) : [...referencedEnv].filter((k) => k in mergedEnv);
  for (const k of referencedEnv) if (!(k in mergedEnv)) report.warnings.push(`process.env.${k} is read by a handler but not defined in .env/.env.production: it will be undefined on chain`);
  if (envNames.length) report.warnings.push(`environment baked into the program (public on chain): ${envNames.join(', ')}`);
  const env = envNames.map((k) => [k, String(mergedEnv[k])]);

  const header = [
    `${deployment.source || 'deployment'}${deployment.framework ? ` (${deployment.framework})` : ''} — ${routes.length} route(s), ${(deployment.staticFiles || []).length} static file(s)`,
    ...routes.map((r) => `route ${r.index}: ${r.routePath}${r.methods ? ' [' + r.methods.join(',') + ']' : ''} ← ${r.name}`),
  ].join('\n');
  const target = opts.target === 'shared' ? 'shared' : 'program';
  let crate = null;
  let code = null;
  if (target === 'shared') {
    // The shared runtime: a bytecode module (a few KB) instead of a crate.
    code = emitModule({ routes: loweredIrs.map((ir) => ({ ir })), env });
  } else {
    const crateFiles = emitCrate({ name, runtimePath, env, routes: routeSources, routeCount: routes.length, header });
    crate = { 'Cargo.toml': crateFiles['Cargo.toml'], 'src/lib.rs': crateFiles['src/lib.rs'] };
  }

  const manifest = {
    version: MANIFEST_VERSION,
    framework: deployment.framework || null,
    routes,
    static: (deployment.staticFiles || []).map((f) => ({ path: f.path, contentType: f.contentType, size: f.size })),
    env: envNames,
    config: deployment.config,
    target,
  };
  return { crate, code, manifest, report, crateName: crate ? name : null, target };
}

/** Write a transmuted crate to `dir` (creates src/). Returns the paths written. */
export function writeCrate(crate, dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const written = [];
  for (const [rel, text] of Object.entries(crate)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    written.push(p);
  }
  return written;
}
