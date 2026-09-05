// The openzoo-transmute command line.
//
// The openzoo package can mount these subcommands in its own bin without
// duplicating anything:
//
//   case 'build': case 'deploy': case 'serve':
//     await (await import('openzoo-transmute/lib/cli.js')).run(process.argv.slice(2));
//
// `run(argv)` resolves to the exit code (0 = ok) and also sets
// `process.exitCode` when non-zero; it never calls `process.exit` itself so a
// `serve` keeps the event loop (and the http server) alive.
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { readDeployment } from './vercel.js';
import { build } from './build.js';
import { deploy, resolveOutDir, clusterLabel } from './deploy.js';
import { startGateway, DEFAULT_PORT } from './gateway.js';
import { startHub, DEFAULT_HUB_PORT } from './hub.js';
import { connect, getProgramInfo, readManifest } from './solana.js';
import { loadWallet, rpcUrl } from './wallet.js';
import { MANIFEST_PATH } from './wire.js';

export const USAGE = `openzoo-transmute — Vercel app → Solana program + asset accounts

usage:
  openzoo-transmute build   [dir] [--out .zoo-out] [--name <crate>] [--arch v0|v3] [--cluster <c>] [--skip-cargo]
  openzoo-transmute deploy  [dir|outDir] [--cluster mainnet|devnet|localnet|<url>] [--keypair <path>] [--yes] [--program <id>]
                            [--concurrency 4] [--skip-assets] [--force]
  openzoo-transmute serve   <programId> [--cluster <c>] [--port ${DEFAULT_PORT}] [--keypair <path>] [--host 127.0.0.1] [--quiet]
  openzoo-transmute hub     [--cluster mainnet] [--port 8080] [--host 0.0.0.0] [--public-url <https://…>]
                            hosted explorer for EVERY program on the cluster (/s/<programId>), read-only
  openzoo-transmute inspect [dir]                 print the Vercel model + eligibility report
  openzoo-transmute status  <programId> [--cluster <c>]
  openzoo-transmute help

clusters: mainnet (default, needs --yes to deploy), devnet, testnet, localnet, or an RPC URL.
env: OPENZOO_CLUSTER, OPENZOO_RPC (mainnet RPC), OPENZOO_KEYPAIR / OPENZOO_WALLET (signer).
`;

/** `--k v`, `--k=v`, `--flag`, `--no-flag`; everything else is positional. */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const boolFlags = new Set(['yes', 'skip-cargo', 'skip-assets', 'force', 'quiet', 'help', 'json', 'version']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      let val;
      if (eq >= 0) val = a.slice(eq + 1);
      else if (key.startsWith('no-')) { key = key.slice(3); val = false; }
      else if (boolFlags.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) val = true;
      else val = argv[++i];
      flags[key] = val;
      flags[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
    } else if (a === '-h') flags.help = true;
    else if (a === '-y') flags.yes = true;
    else positionals.push(a);
  }
  return { cmd: positionals[0] || 'help', positionals: positionals.slice(1), flags };
}

function fmtBytes(n) { return n == null ? '?' : n.toLocaleString() + ' B'; }

export function inspectText(deployment, report = null) {
  const lines = [];
  lines.push(`${deployment.root}`);
  lines.push(`source: ${deployment.source}${deployment.framework ? ` · framework: ${deployment.framework}` : ''} · static dir: ${deployment.staticDir ? path.relative(deployment.root, deployment.staticDir) || '.' : '-'}`);
  for (const n of deployment.notes) lines.push(`note: ${n}`);
  lines.push('');
  lines.push(`functions (${deployment.functions.length}):`);
  const inel = new Map((report?.ineligible || []).map((i) => [i.name, i]));
  const elig = new Set((report?.eligible || []).map((e) => (typeof e === 'string' ? e : e.name)));
  for (const f of deployment.functions) {
    const mark = report ? (inel.has(f.name) ? '✗' : elig.has(f.name) ? '✓' : '?') : ' ';
    const meth = f.methods ? f.methods.join(',') : 'any';
    lines.push(`  ${mark} ${f.routePath.padEnd(32)} ${f.style.padEnd(12)} ${f.runtime.padEnd(11)} ${String(f.maxDuration + 's').padEnd(5)} ${String(f.memory + 'MB').padEnd(7)} ${meth}${f.params.length ? `  params=${f.params.join(',')}` : ''}${f.middleware ? '  middleware' : ''}${f.prerender ? '  ISR' : ''}`);
    lines.push(`      ${f.sourceFile ? path.relative(deployment.root, f.sourceFile) : '(no source)'}${Object.keys(f.environment || {}).length ? `  env=${Object.keys(f.environment).join(',')}` : ''}`);
    const r = inel.get(f.name);
    if (r) lines.push(`      ineligible: ${r.reason}${r.line ? ` (line ${r.line})` : ''}`);
  }
  if (deployment.crons.length) { lines.push(''); lines.push(`crons (${deployment.crons.length}) — not transmuted, Solana has no scheduler:`); for (const c of deployment.crons) lines.push(`  ${c.schedule || '?'}  ${c.path || ''}`); }
  lines.push('');
  const total = deployment.staticFiles.reduce((n, f) => n + f.size, 0);
  lines.push(`static files (${deployment.staticFiles.length}, ${fmtBytes(total)}):`);
  for (const f of deployment.staticFiles.slice(0, 60)) lines.push(`  ${f.path.padEnd(48)} ${f.contentType.padEnd(32)} ${fmtBytes(f.size)}`);
  if (deployment.staticFiles.length > 60) lines.push(`  … ${deployment.staticFiles.length - 60} more`);
  if (report) {
    lines.push('');
    lines.push(`eligibility: ${report.eligible.length} eligible, ${report.ineligible.length} ineligible, ${report.warnings.length} warning(s)`);
    for (const w of report.warnings) lines.push(`  ! ${typeof w === 'string' ? w : w.message || JSON.stringify(w)}`);
  }
  const routes = deployment.config?.routes || [];
  if (routes.length) {
    lines.push('');
    lines.push(`routes (${routes.length}):`);
    for (const r of routes) lines.push('  ' + (r.handle ? `[handle: ${r.handle}]` : `${r.src} → ${r.dest || (r.status ? `status ${r.status}` : '(headers)')}${r.continue ? ' (continue)' : ''}`));
  }
  return lines.join('\n');
}

async function tryTransmute(deployment) {
  try {
    const mod = await import('./compile/index.js');
    if (typeof mod.transmute !== 'function') return null;
    const r = await mod.transmute(deployment, { name: 'inspect', dryRun: true });
    return r?.report || null;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') return null;
    return { eligible: [], ineligible: [], warnings: [`compiler failed: ${e?.message || e}`] };
  }
}

async function cmdBuild(p, f, log) {
  const r = await build(p[0] || '.', { out: f.out, name: f.name, arch: f.arch, cluster: f.cluster, runtimePath: f.runtime, skipCargo: !!f.skipCargo, log });
  if (f.json) log(JSON.stringify({ outDir: r.outDir, soPath: r.soPath, arch: r.arch, report: r.report, costEstimate: { sol: r.costEstimate.sol, totalSol: r.costEstimate.totalSol, source: r.costEstimate.source } }, null, 2));
  return r.report.ineligible.length && !r.report.eligible.length && r.manifest.routes.length === 0 && r.deployment.functions.length ? 2 : 0;
}

async function cmdDeploy(p, f, log) {
  const r = await deploy({ outDir: p[0] || '.', cluster: f.cluster, keypair: f.keypair, programId: f.program, yes: !!f.yes, concurrency: f.concurrency ? Number(f.concurrency) : undefined, skipAssets: !!f.skipAssets, force: !!f.force, log });
  if (f.json) log(JSON.stringify(r, null, 2));
  return 0;
}

async function cmdServe(p, f, log) {
  let programId = p[0];
  if (!programId) {
    // Fall back to the last deploy in ./ or ./.zoo-out.
    try { programId = JSON.parse(fs.readFileSync(path.join(resolveOutDir('.'), '.zoo', 'deploy.json'), 'utf8')).programId; } catch { /* none */ }
    if (!programId) throw new Error('usage: serve <programId> (no .zoo/deploy.json found to infer it from)');
  }
  new PublicKey(programId); // validate
  let keypair = null, walletPath = null;
  if (f.keypair !== false) {
    try { const w = loadWallet({ keypair: typeof f.keypair === 'string' ? f.keypair : undefined }); keypair = w.keypair; walletPath = w.path; }
    catch (e) { if (typeof f.keypair === 'string') throw e; log(`no wallet found (${String(e.message).split(';')[0]}); mutating requests will answer 402`); }
  }
  const port = f.port != null ? Number(f.port) : DEFAULT_PORT;
  const host = f.host || '127.0.0.1';
  if (keypair && !/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(host)) log(`warning: binding ${host} with a signer: anyone who can reach this gateway can send transactions paid by ${keypair.publicKey.toBase58()}; use --no-keypair unless that is intended`);
  const gw = await startGateway({ programId, cluster: f.cluster, port, host, keypair, log, quiet: !!f.quiet });
  const m = gw.state.manifest;
  log(`openzoo-transmute gateway → ${gw.url}/  (explorer ${gw.url}/.zoo/, manifest ${gw.url}${MANIFEST_PATH})`);
  log(`program ${programId} on ${gw.state.cluster} · ${m.routes.length} function(s), ${m.static ? m.static.length : '?'} asset(s) · signer ${keypair ? keypair.publicKey.toBase58() + (walletPath ? ` (${walletPath})` : '') : 'none (reads only)'}`);
  for (const r of m.routes) log(`  ${(r.methods && r.methods.length ? r.methods.join('|') : 'ANY').padEnd(16)} ${r.routePath}`);
  const stop = () => gw.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}

async function cmdInspect(p, f, log) {
  const deployment = readDeployment(p[0] || '.');
  const report = await tryTransmute(deployment);
  if (f.json) log(JSON.stringify({ ...deployment, report }, null, 2));
  else {
    log(inspectText(deployment, report));
    if (!report) log('\n(compiler not available: eligibility not checked)');
  }
  return 0;
}

async function cmdStatus(p, f, log) {
  if (!p[0]) throw new Error('usage: status <programId> [--cluster <c>]');
  const programId = new PublicKey(p[0]);
  const rpc = rpcUrl(f.cluster);
  const connection = connect(rpc);
  const [info, slot, manifest] = await Promise.all([getProgramInfo(connection, programId), connection.getSlot('confirmed'), readManifest(connection, programId).catch(() => null)]);
  const out = {
    programId: programId.toBase58(), cluster: clusterLabel(f.cluster), rpc: rpc.replace(/\?.*$/, ''), slot,
    exists: info.exists, executable: info.executable ?? null, authority: info.authority ? info.authority.toBase58() : null,
    deploySlot: info.slot, maxDataLen: info.maxDataLen, programData: info.programData.toBase58(),
    manifest: manifest ? { name: manifest.name, framework: manifest.framework, routes: manifest.routes?.length ?? 0, static: manifest.static?.length ?? 0, deployedAt: manifest.deployedAt, arch: manifest.arch } : null,
  };
  if (f.json) { log(JSON.stringify(out, null, 2)); return info.exists ? 0 : 1; }
  log(`program     ${out.programId} on ${out.cluster} (${out.rpc}) @ slot ${slot}`);
  if (!info.exists) { log('status      NOT DEPLOYED'); return 1; }
  log(`status      deployed at slot ${out.deploySlot}${out.executable === false ? ' (not executable!)' : ''}`);
  log(`authority   ${out.authority || 'none (immutable)'}`);
  log(`programData ${out.programData} (max ${out.maxDataLen?.toLocaleString()} B)`);
  if (manifest) {
    log(`manifest    ${manifest.name || ''} ${manifest.framework || ''} · ${out.manifest.routes} function(s), ${out.manifest.static} asset(s) · deployed ${manifest.deployedAt || '?'}${manifest.arch ? ` (${manifest.arch})` : ''}`);
    for (const r of manifest.routes || []) log(`  ${(r.methods && r.methods.length ? r.methods.join('|') : 'ANY').padEnd(16)} ${r.routePath}`);
  } else log(`manifest    none at ${MANIFEST_PATH}`);
  return 0;
}

/**
 * Run the CLI. Returns the exit code; prints errors to stderr.
 * @param {string[]} argv  arguments after the program name
 * @param {{log?:Function, error?:Function}} io
 */
async function cmdHub(p, f, log) {
  // The hosted explorer: every program on the cluster from one public host,
  // read-only by default (a public signer would be a drain). --keypair opts in.
  const cluster = f.cluster || process.env.OPENZOO_CLUSTER || 'mainnet';
  let keypair = null;
  if (typeof f.keypair === 'string') { keypair = loadWallet({ keypair: f.keypair }).keypair; log(`warning: this hub signs writes with ${keypair.publicKey.toBase58()} for anyone who can reach it`); }
  const port = f.port != null ? Number(f.port) : Number(process.env.PORT || DEFAULT_HUB_PORT);
  const h = await startHub({ cluster, port, host: f.host || '0.0.0.0', keypair, log, quiet: !!f.quiet, publicUrl: f.publicUrl || process.env.OPENZOO_HUB_URL || null, maxSites: f.maxSites ? Number(f.maxSites) : undefined });
  log(`openzoo hub → ${h.url}/.hub  (cluster ${cluster}; sites at ${h.url}/s/<programId>)`);
  const stop = () => h.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}

export async function run(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const { cmd, positionals, flags } = parseArgs(argv);
  if (flags.version) { log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return 0; }
  if (flags.help || cmd === 'help' || cmd === '--help') { log(USAGE); return 0; }
  const commands = { build: cmdBuild, deploy: cmdDeploy, serve: cmdServe, inspect: cmdInspect, status: cmdStatus, hub: cmdHub };
  const fn = commands[cmd];
  if (!fn) { error(`unknown command: ${cmd}\n`); error(USAGE); process.exitCode = 1; return 1; }
  try {
    const code = (await fn(positionals, flags, log)) || 0;
    if (code) process.exitCode = code;
    return code;
  } catch (e) {
    error(`error: ${e?.message || e}`);
    if (process.env.OPENZOO_DEBUG && e?.stack) error(e.stack);
    process.exitCode = 1;
    return 1;
  }
}
