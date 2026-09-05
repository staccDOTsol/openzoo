// `build`: Vercel deployment model → Rust crate → .so, plus the cost sheet.
//
//   readDeployment(root) → transmute() → <out>/.zoo/{crate/, manifest.json,
//   report.json, static-plan.json, build.json} → cargo build-sbf → .so
//
// The compiler (lib/compile/index.js) owns the JS→Rust translation; this
// module owns the filesystem layout, the cargo invocation and the rent
// estimate so `deploy` can pick the artifacts up without re-reading the
// source repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDeployment } from './vercel.js';
import { ASSET_FIXED_HEADER, MANIFEST_PATH } from './wire.js';
import { connect } from './solana.js';
import { rpcUrl } from './wallet.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_PATH = path.resolve(HERE, '..', 'runtime', 'zoo-host');
export const SOLANA_BIN = path.join(os.homedir(), '.local', 'share', 'solana', 'install', 'active_release', 'bin');
export const INSTALL_HINT = 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"';
export const DEFAULT_ARCH = 'v0';
export const ARCHES = ['v0', 'v1', 'v2', 'v3', 'v4'];
/** Rent rule of thumb: 3480 lamports per byte-year × 2 years = 6960 lamports/byte ≈ 6.96 SOL/MB. */
export const LAMPORTS_PER_BYTE = 6960;
export const ACCOUNT_OVERHEAD_BYTES = 128;
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** BPF upgradeable loader account sizes. */
export const PROGRAM_ACCOUNT_BYTES = 36;
export const PROGRAMDATA_HEADER_BYTES = 45;
export const BUFFER_HEADER_BYTES = 37;

// ---------------------------------------------------------------- naming

/** A crate name Cargo accepts, derived from the project directory (or --name). */
export function crateNameFor(root, name) {
  const base = (name || path.basename(path.resolve(root)) || 'site').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const safe = /^[a-z]/.test(base) ? base : 'site-' + base;
  return safe || 'site';
}
export function soNameFor(crateName) { return crateName.replace(/-/g, '_') + '.so'; }

/** Parse `[package] name` out of a Cargo.toml (falls back to `fallback`). */
export function packageNameOf(cargoToml, fallback) {
  const m = String(cargoToml || '').match(/\[package\][^[]*?\bname\s*=\s*"([^"]+)"/);
  return m ? m[1] : fallback;
}

// ---------------------------------------------------------------- cargo

/** Process env with the Solana toolchain on PATH (`cargo build-sbf` lives there). */
export function solanaEnv(extra = {}) {
  const sep = path.delimiter;
  const cur = process.env.PATH || '';
  const parts = cur.split(sep);
  const PATH = parts.includes(SOLANA_BIN) ? cur : [SOLANA_BIN, path.join(os.homedir(), '.cargo', 'bin'), cur].filter(Boolean).join(sep);
  return { ...process.env, PATH, ...extra };
}

/** Absolute path of `cargo-build-sbf` on the given PATH, or null. */
export function findCargoBuildSbf(env = solanaEnv()) {
  const exe = process.platform === 'win32' ? 'cargo-build-sbf.exe' : 'cargo-build-sbf';
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Run `cargo build-sbf --arch <arch>` in `crateDir`. Never throws for a
 * missing toolchain: returns `{ok:false, missing:true}` with the install hint.
 * @returns {Promise<{ok:boolean, missing?:boolean, soPath:string|null, arch:string, code?:number, output:string, error?:string}>}
 */
export async function runCargoBuildSbf(crateDir, { arch = DEFAULT_ARCH, outDir, log = console.log, env = solanaEnv(), cargo = 'cargo', extraArgs = [] } = {}) {
  if (!ARCHES.includes(arch)) throw new Error(`unknown --arch ${arch} (expected one of ${ARCHES.join(', ')})`);
  const sbfOut = outDir || path.join(crateDir, 'target', 'deploy');
  if (!findCargoBuildSbf(env) && cargo === 'cargo') {
    log(`cargo-build-sbf not found on PATH (looked in ${SOLANA_BIN}).`);
    log(`install the Solana toolchain with:\n    ${INSTALL_HINT}\nthen re-run \`build\`; continuing without a .so.`);
    return { ok: false, missing: true, soPath: null, arch, output: '', error: 'cargo-build-sbf not installed' };
  }
  const args = ['build-sbf', '--arch', arch, '--sbf-out-dir', sbfOut, ...extraArgs];
  log(`$ ${cargo} ${args.join(' ')}   (in ${crateDir})`);
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(cargo, args, { cwd: crateDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: -1, output: '', error: String(e?.message || e) }); }
    const onData = (d) => { const s = d.toString(); output += s; for (const line of s.split('\n')) if (line.trim()) log('  ' + line.trimEnd()); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => resolve({ code: -1, output, error: String(e?.message || e) }));
    child.on('close', (code) => resolve({ code, output }));
  });
  if (res.error && /ENOENT/.test(res.error)) {
    log(`\`${cargo}\` is not installed. Install the Solana toolchain with:\n    ${INSTALL_HINT}`);
    return { ok: false, missing: true, soPath: null, arch, output: res.output, error: res.error };
  }
  if (res.code !== 0) return { ok: false, soPath: null, arch, code: res.code, output: res.output, error: res.error || `cargo build-sbf exited with ${res.code}` };
  const soPath = findSo(sbfOut, res.output);
  log(`built ${soPath ? path.relative(process.cwd(), soPath) : '(no .so found?)'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { ok: !!soPath, soPath, arch, code: 0, output: res.output, error: soPath ? undefined : `no .so found in ${sbfOut}` };
}

function findSo(dir, output = '') {
  const m = output.match(/\b(\/\S+\.so)\b/);
  if (m && fs.existsSync(m[1])) return m[1];
  if (!fs.existsSync(dir)) return null;
  const sos = fs.readdirSync(dir).filter((f) => f.endsWith('.so')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return sos[0] || null;
}

// ---------------------------------------------------------------- cost

function accountBytesFor(kind, size, contentType = '') {
  switch (kind) {
    case 'asset': return ASSET_FIXED_HEADER + Buffer.byteLength(contentType.slice(0, 120)) + size;
    case 'program': return PROGRAM_ACCOUNT_BYTES;
    case 'programdata': return PROGRAMDATA_HEADER_BYTES + size;
    case 'buffer': return BUFFER_HEADER_BYTES + size;
    default: return size;
  }
}

/** Reach the cluster within `timeoutMs`; null when unreachable. */
export async function probeConnection(cluster, { timeoutMs = 2500 } = {}) {
  let url;
  try { url = rpcUrl(cluster); } catch { return null; }
  const connection = connect(url);
  try {
    await Promise.race([connection.getSlot('confirmed'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs).unref?.())]);
    return connection;
  } catch { return null; }
}

/**
 * Rent the deployment will lock. Uses the cluster's real rent parameters
 * when a connection is given, else the 6.96 SOL/MB rule of thumb.
 * @param {{staticFiles:Array<{path:string,size:number,contentType?:string}>, soSize?:number|null, manifestBytes?:number, connection?:object|null, upgrade?:boolean}} o
 */
export async function estimateCost({ staticFiles = [], soSize = null, manifestBytes = 0, connection = null, upgrade = false }) {
  const items = [];
  if (soSize != null) {
    if (upgrade) items.push({ label: 'program upgrade buffer (refunded on success)', kind: 'buffer', bytes: accountBytesFor('buffer', soSize), transient: true });
    else {
      items.push({ label: 'program account', kind: 'program', bytes: accountBytesFor('program', 0) });
      items.push({ label: `program data (.so = ${soSize.toLocaleString()} B)`, kind: 'programdata', bytes: accountBytesFor('programdata', soSize) });
    }
  } else {
    items.push({ label: 'program (no .so built yet)', kind: 'program', bytes: 0, unknown: true });
  }
  for (const f of staticFiles) items.push({ label: f.path, kind: 'asset', bytes: accountBytesFor('asset', f.size, f.contentType || '') });
  items.push({ label: MANIFEST_PATH + ' (manifest)', kind: 'asset', bytes: accountBytesFor('asset', manifestBytes, 'application/json; charset=utf-8') });

  let source = 'rule-of-thumb';
  const rentFor = new Map();
  if (connection) {
    try {
      const sizes = [...new Set(items.filter((i) => !i.unknown).map((i) => i.bytes))];
      await Promise.all(sizes.map(async (n) => rentFor.set(n, await connection.getMinimumBalanceForRentExemption(n))));
      source = 'rpc';
    } catch { rentFor.clear(); }
  }
  let lamports = 0, transientLamports = 0;
  for (const it of items) {
    it.lamports = it.unknown ? 0 : (rentFor.get(it.bytes) ?? (ACCOUNT_OVERHEAD_BYTES + it.bytes) * LAMPORTS_PER_BYTE);
    it.sol = it.lamports / LAMPORTS_PER_SOL;
    if (it.transient) transientLamports += it.lamports; else lamports += it.lamports;
  }
  const feeLamports = 5000 * (1 + Math.ceil((soSize || 0) / 900) + staticFiles.reduce((n, f) => n + 1 + Math.ceil(f.size / 900), 0) + 2);
  return {
    source, rpc: connection?.rpcEndpoint || null, items,
    lamports, sol: lamports / LAMPORTS_PER_SOL,
    transientLamports, transientSol: transientLamports / LAMPORTS_PER_SOL,
    feeLamports, feeSol: feeLamports / LAMPORTS_PER_SOL,
    totalLamports: lamports + transientLamports + feeLamports,
    totalSol: (lamports + transientLamports + feeLamports) / LAMPORTS_PER_SOL,
    unknownProgram: soSize == null,
  };
}

/** Render the cost estimate as a plain-text table. */
export function formatCostTable(est, { maxRows = 40 } = {}) {
  const rows = est.items.map((i) => [i.label, i.unknown ? '?' : i.bytes.toLocaleString(), i.unknown ? '?' : i.sol.toFixed(4)]);
  const shown = rows.length > maxRows ? [...rows.slice(0, maxRows), [`… ${rows.length - maxRows} more files`, '', '']] : rows;
  shown.push(['rent total', '', est.sol.toFixed(4)]);
  if (est.transientLamports) shown.push(['+ transient (refunded)', '', est.transientSol.toFixed(4)]);
  shown.push(['+ tx fees (approx.)', '', est.feeSol.toFixed(4)]);
  shown.push(['TOTAL', '', est.totalSol.toFixed(4)]);
  const w0 = Math.min(60, Math.max(...shown.map((r) => r[0].length), 4));
  const w1 = Math.max(...shown.map((r) => r[1].length), 5);
  const lines = [`  ${'item'.padEnd(w0)}  ${'bytes'.padStart(w1)}  ${'SOL'.padStart(8)}`];
  for (const [a, b, c] of shown) lines.push(`  ${a.length > w0 ? a.slice(0, w0 - 1) + '…' : a.padEnd(w0)}  ${b.padStart(w1)}  ${c.padStart(8)}`);
  lines.push(`  (rent per ${est.source === 'rpc' ? est.rpc.replace(/\?.*$/, '') : 'the 6.96 SOL/MB rule of thumb'}${est.unknownProgram ? '; program rent unknown until the .so is built' : ''})`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- build

async function loadTransmute() {
  try {
    const mod = await import('./compile/index.js');
    if (typeof mod.transmute !== 'function') throw new Error('lib/compile/index.js does not export transmute()');
    return mod.transmute;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /compile\/index\.js/.test(String(e.message))) {
      throw new Error('the compiler (lib/compile/index.js) is not present in this install of openzoo-transmute');
    }
    throw e;
  }
}

function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

/** Point the generated Cargo.toml at a zoo-host checkout that exists on this machine. */
export function fixRuntimePath(cargoToml, runtimePath) {
  const rt = runtimePath.replace(/\\/g, '/');
  const re = /(zoo-host\s*=\s*\{[^}]*?\bpath\s*=\s*")([^"]*)(")/;
  const m = cargoToml.match(re);
  if (!m) return cargoToml.includes('zoo-host') ? cargoToml : cargoToml + `\n[dependencies.zoo-host]\npath = "${rt}"\n`;
  if (path.isAbsolute(m[2]) && fs.existsSync(path.join(m[2], 'Cargo.toml'))) return cargoToml;
  return cargoToml.replace(re, `$1${rt}$3`);
}

/**
 * Build a Vercel-shaped repo into `<out>/.zoo/`.
 *
 * @param {string} root         the app's directory
 * @param {{out?:string, name?:string, arch?:string, cluster?:string, runtimePath?:string, skipCargo?:boolean,
 *          transmute?:Function, log?:Function, cargo?:string, connection?:object|null}} opts
 * @returns {Promise<{outDir:string, zooDir:string, crateDir:string, manifest:object, report:object, soPath:string|null, arch:string, costEstimate:object, deployment:object, notes:string[]}>}
 */
export async function build(root = '.', opts = {}) {
  const log = opts.log ?? console.log;
  root = path.resolve(root);
  if (!fs.existsSync(root)) throw new Error(`${root}: no such directory`);
  const outDir = path.resolve(opts.out || path.join(root, '.zoo-out'));
  const zooDir = path.join(outDir, '.zoo');
  const crateDir = path.join(zooDir, 'crate');
  const notes = [];

  const deployment = readDeployment(root);
  const name = crateNameFor(root, opts.name);
  const runtimePath = path.resolve(opts.runtimePath || RUNTIME_PATH);
  log(`reading ${root} → ${deployment.source}${deployment.framework ? ` (${deployment.framework})` : ''}: ${deployment.functions.length} function(s), ${deployment.staticFiles.length} static file(s)`);
  for (const n of deployment.notes) { log(`note: ${n}`); notes.push(n); }

  const target = opts.target === 'shared' ? 'shared' : 'program';
  const transmute = opts.transmute || await loadTransmute();
  const result = await transmute(deployment, { name, runtimePath, arch: opts.arch, root, outDir, target });
  if (target === 'shared') return buildShared({ root, outDir, zooDir, deployment, name, result, notes, log, opts });
  if (!result || !result.crate || !result.crate['Cargo.toml'] || !result.crate['src/lib.rs']) throw new Error('transmute() returned no crate (expected {crate:{"Cargo.toml","src/lib.rs"}, manifest, report})');
  const manifest = { name, ...(result.manifest || {}) };
  if (!manifest.version) manifest.version = 1;
  if (!manifest.framework) manifest.framework = deployment.framework;
  if (!Array.isArray(manifest.routes)) manifest.routes = [];
  if (!Array.isArray(manifest.static)) manifest.static = deployment.staticFiles.map((f) => ({ path: f.path, contentType: f.contentType, size: f.size }));
  if (!manifest.config) manifest.config = deployment.config;
  const report = { eligible: [], ineligible: [], warnings: [], ...(result.report || {}) };

  // Lay the crate out.
  fs.rmSync(crateDir, { recursive: true, force: true });
  fs.mkdirSync(crateDir, { recursive: true });
  for (const [rel, content] of Object.entries(result.crate)) {
    const p = path.join(crateDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel === 'Cargo.toml' ? fixRuntimePath(String(content), runtimePath) : content);
  }
  const crateName = packageNameOf(result.crate['Cargo.toml'], name);
  const byPath = new Map(deployment.staticFiles.map((f) => [f.path, f]));
  const staticPlan = manifest.static.map((s) => ({ ...s, file: byPath.get(s.path)?.file || s.file || null }));
  writeJson(path.join(zooDir, 'manifest.json'), manifest);
  writeJson(path.join(zooDir, 'report.json'), report);
  writeJson(path.join(zooDir, 'static-plan.json'), staticPlan);
  log(`wrote ${path.relative(process.cwd(), zooDir) || zooDir}/{crate/, manifest.json, report.json, static-plan.json}`);
  log(`functions: ${report.eligible.length} eligible, ${report.ineligible.length} ineligible${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ''}`);
  for (const i of report.ineligible) log(`  ✗ ${i.name}: ${i.reason}${i.file ? ` (${path.relative(root, i.file)}${i.line ? ':' + i.line : ''})` : ''}`);
  for (const w of report.warnings) log(`  ! ${typeof w === 'string' ? w : w.message || JSON.stringify(w)}`);

  // Compile.
  let arch = opts.arch || DEFAULT_ARCH;
  if (!opts.arch) { const n = `no --arch given: building for ${DEFAULT_ARCH} (mainnet); \`deploy\` re-detects the cluster's SBPF version and rebuilds if needed`; notes.push(n); log(`note: ${n}`); }
  let soPath = null, cargo = null;
  if (opts.skipCargo) { notes.push('cargo build skipped (--skip-cargo)'); log('skipping cargo build-sbf (--skip-cargo)'); }
  else {
    cargo = await runCargoBuildSbf(crateDir, { arch, outDir: path.join(zooDir, 'deploy'), log, cargo: opts.cargo, env: opts.env });
    if (cargo.ok) soPath = cargo.soPath;
    else if (cargo.missing) notes.push(`cargo-build-sbf not installed; install with: ${INSTALL_HINT}`);
    else throw Object.assign(new Error(`cargo build-sbf failed (${cargo.error})\n${cargo.output.split('\n').filter((l) => /error/i.test(l)).slice(0, 20).join('\n')}`), { output: cargo.output });
  }
  const soSize = soPath ? fs.statSync(soPath).size : null;
  writeJson(path.join(zooDir, 'build.json'), {
    name, crateName, root, outDir, arch, soPath, soSize, soName: soNameFor(crateName), builtAt: new Date().toISOString(),
    runtimePath, cargo: cargo ? { ok: cargo.ok, missing: !!cargo.missing } : { skipped: true }, target: 'program',
  });

  // Cost sheet.
  const connection = opts.connection !== undefined ? opts.connection : await probeConnection(opts.cluster || 'localnet');
  const manifestBytes = Buffer.byteLength(JSON.stringify({ ...manifest, programId: 'x'.repeat(44), deployedAt: new Date().toISOString() }));
  const costEstimate = await estimateCost({ staticFiles: staticPlan, soSize, manifestBytes, connection });
  log('');
  log(formatCostTable(costEstimate));
  log('');
  if (soPath) log(`.so: ${soPath} (${soSize.toLocaleString()} B, ${arch})`);
  log(`next: openzoo-transmute deploy ${path.relative(process.cwd(), outDir) || outDir} --cluster <localnet|devnet|mainnet>`);
  return { outDir, zooDir, crateDir, manifest, report, soPath, arch, costEstimate, deployment, notes, staticPlan };
}

// ---------------------------------------------------------------- shared runtime

/** Bytes of the site account the shared runtime creates per site. */
export const SITE_ACCOUNT_BYTES = 66;

/** Rent for a shared-runtime site: site account + code asset + assets + manifest (no program). */
export async function estimateSharedCost({ staticFiles = [], codeSize = 0, manifestBytes = 0, connection = null }) {
  const est = await estimateCost({ staticFiles, soSize: null, manifestBytes, connection });
  est.items = est.items.filter((i) => i.kind !== 'program');
  const rent = async (n) => { if (connection) { try { return await connection.getMinimumBalanceForRentExemption(n); } catch {} } return (ACCOUNT_OVERHEAD_BYTES + n) * LAMPORTS_PER_BYTE; };
  const codeBytes = accountBytesFor('asset', codeSize, 'application/x-zoo-bytecode');
  const extra = [
    { label: 'site account (shared runtime)', kind: 'site', bytes: SITE_ACCOUNT_BYTES, lamports: await rent(SITE_ACCOUNT_BYTES) },
    { label: `/.zoo/code.bin (bytecode = ${codeSize.toLocaleString()} B)`, kind: 'asset', bytes: codeBytes, lamports: await rent(codeBytes) },
  ];
  for (const it of extra) it.sol = it.lamports / LAMPORTS_PER_SOL;
  est.items = [...extra, ...est.items];
  est.lamports += extra.reduce((n, i) => n + i.lamports, 0);
  est.sol = est.lamports / LAMPORTS_PER_SOL;
  est.feeLamports = 5000 * (2 + Math.ceil(codeSize / 900) + staticFiles.reduce((n, f) => n + 1 + Math.ceil(f.size / 900), 0) + 2);
  est.feeSol = est.feeLamports / LAMPORTS_PER_SOL;
  est.totalLamports = est.lamports + est.transientLamports + est.feeLamports;
  est.totalSol = est.totalLamports / LAMPORTS_PER_SOL;
  est.unknownProgram = false;
  est.shared = true;
  return est;
}

/** `build --target shared`: bytecode module instead of a crate; nothing to compile. */
async function buildShared({ root, outDir, zooDir, deployment, name, result, notes, log, opts }) {
  if (!result || !result.code || !result.code.length) throw new Error('transmute() returned no bytecode module for --target shared');
  const manifest = { name, ...(result.manifest || {}), target: 'shared' };
  if (!manifest.version) manifest.version = 1;
  if (!manifest.framework) manifest.framework = deployment.framework;
  if (!Array.isArray(manifest.routes)) manifest.routes = [];
  if (!Array.isArray(manifest.static)) manifest.static = deployment.staticFiles.map((f) => ({ path: f.path, contentType: f.contentType, size: f.size }));
  if (!manifest.config) manifest.config = deployment.config;
  const runtime = opts.runtime || process.env.OPENZOO_VM_PROGRAM || null;
  if (runtime) manifest.runtime = runtime;
  const report = { eligible: [], ineligible: [], warnings: [], ...(result.report || {}) };

  fs.rmSync(path.join(zooDir, 'crate'), { recursive: true, force: true });
  fs.mkdirSync(zooDir, { recursive: true });
  const codePath = path.join(zooDir, 'code.bin');
  fs.writeFileSync(codePath, result.code);
  const byPath = new Map(deployment.staticFiles.map((f) => [f.path, f]));
  const staticPlan = manifest.static.map((s) => ({ ...s, file: byPath.get(s.path)?.file || s.file || null }));
  writeJson(path.join(zooDir, 'manifest.json'), manifest);
  writeJson(path.join(zooDir, 'report.json'), report);
  writeJson(path.join(zooDir, 'static-plan.json'), staticPlan);
  const codeSize = result.code.length;
  writeJson(path.join(zooDir, 'build.json'), { name, root, outDir, target: 'shared', codePath, codeSize, runtime, builtAt: new Date().toISOString(), cargo: { skipped: true } });
  log(`wrote ${path.relative(process.cwd(), zooDir) || zooDir}/{code.bin (${codeSize.toLocaleString()} B bytecode), manifest.json, report.json, static-plan.json}`);
  log(`functions: ${report.eligible.length} eligible, ${report.ineligible.length} ineligible${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ''}`);
  for (const i of report.ineligible) log(`  ✗ ${i.name}: ${i.reason}${i.file ? ` (${path.relative(root, i.file)}${i.line ? ':' + i.line : ''})` : ''}`);
  for (const w of report.warnings) log(`  ! ${typeof w === 'string' ? w : w.message || JSON.stringify(w)}`);
  if (!runtime) { const n = 'no --runtime given: pass --runtime <zoo-vm program id> (or OPENZOO_VM_PROGRAM) at deploy time'; notes.push(n); log(`note: ${n}`); }

  const connection = opts.connection !== undefined ? opts.connection : await probeConnection(opts.cluster || 'localnet');
  const manifestBytes = Buffer.byteLength(JSON.stringify({ ...manifest, runtime: 'x'.repeat(44), site: 'x'.repeat(44), deployedAt: new Date().toISOString() }));
  const costEstimate = await estimateSharedCost({ staticFiles: staticPlan, codeSize, manifestBytes, connection });
  log('');
  log(formatCostTable(costEstimate));
  log('');
  log(`next: openzoo-transmute deploy ${path.relative(process.cwd(), outDir) || outDir} --cluster mainnet${runtime ? '' : ' --runtime <id>'}`);
  return { outDir, zooDir, crateDir: null, manifest, report, soPath: null, codePath, codeSize, arch: null, target: 'shared', costEstimate, deployment, notes, staticPlan };
}
