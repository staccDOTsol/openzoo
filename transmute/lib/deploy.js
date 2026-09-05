// `deploy`: push a built `<out>/.zoo/` to a cluster.
//
//   detect SBPF arch (rebuild if the .so was built for another one)
//   → deploy or upgrade the program (keypair kept at .zoo/program-keypair.json)
//   → putAsset every static file
//   → write the manifest as the /.zoo/manifest.json asset
//
// Mainnet is refused without `yes` after the cost table has been printed.
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { MANIFEST_PATH } from './wire.js';
import { connect, deployProgram, upgradeProgram, getProgramInfo, putAsset, detectSbpfArch, pool, assetRent } from './solana.js';
import { loadWallet, rpcUrl } from './wallet.js';
import { runCargoBuildSbf, estimateCost, formatCostTable, LAMPORTS_PER_SOL, INSTALL_HINT } from './build.js';
import { DEFAULT_PORT } from './gateway.js';

export const MANIFEST_CONTENT_TYPE = 'application/json; charset=utf-8';

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw new Error(`${p}: ${e.message}`); }
}
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

/** Accept the app dir, its `.zoo-out`, or the `.zoo` dir itself; return the out dir. */
export function resolveOutDir(dir = '.') {
  const d = path.resolve(dir);
  const candidates = [d, path.join(d, '.zoo-out'), path.dirname(d)];
  for (const c of candidates) if (fs.existsSync(path.join(c, '.zoo', 'manifest.json'))) return c;
  throw new Error(`${d}: no .zoo/manifest.json here or in .zoo-out/; run \`openzoo-transmute build\` first`);
}

export function isMainnet(cluster, rpc) {
  const c = String(cluster || process.env.OPENZOO_CLUSTER || 'mainnet');
  if (/^(localnet|localhost|local|devnet|testnet)$/.test(c)) return false;
  if (/^https?:\/\//.test(c)) return /mainnet/i.test(c) || /(fluxrpc|helius|triton|quiknode|alchemy|ankr)/i.test(c) && !/devnet|testnet/i.test(c);
  return /mainnet/i.test(c) || /mainnet/i.test(rpc || '');
}

/** Genesis hashes of the public clusters: the one signal an RPC URL cannot disguise. */
export const GENESIS_HASHES = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

/** Which public cluster the connection actually serves, by genesis hash; null for a local/unknown one or when unreachable. */
export async function genesisCluster(connection) {
  try {
    const h = await connection.getGenesisHash();
    for (const [name, hash] of Object.entries(GENESIS_HASHES)) if (h === hash) return name;
  } catch { /* unreachable: the URL heuristic stands alone */ }
  return null;
}

export function clusterLabel(cluster) {
  const c = cluster || process.env.OPENZOO_CLUSTER || 'mainnet';
  if (/^https?:\/\//.test(c)) return /127\.0\.0\.1|localhost/.test(c) ? 'localnet' : c;
  return c;
}

/** Load or create the site's program keypair (kept next to the build so redeploys upgrade in place). */
export function programKeypairFor(zooDir, { create = true } = {}) {
  const p = path.join(zooDir, 'program-keypair.json');
  if (fs.existsSync(p)) return { keypair: Keypair.fromSecretKey(Uint8Array.from(readJson(p))), path: p, created: false };
  if (!create) return null;
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  return { keypair: kp, path: p, created: true };
}

/**
 * @param {{outDir?:string, cluster?:string, keypair?:string, programId?:string, yes?:boolean, concurrency?:number,
 *          log?:Function, connection?:object, wallet?:object, skipAssets?:boolean, force?:boolean, cargo?:string}} o
 * @returns {Promise<{programId:string, signature:string|null, signatures:object, assets:{uploaded:number,skipped:number,failed:number,txs:number},
 *          manifestPda:string, url:string, cluster:string, rpc:string, arch:string, upgraded:boolean, deployedAt:string}>}
 */
export async function deploy(o = {}) {
  const log = o.log ?? console.log;
  const outDir = resolveOutDir(o.outDir || '.');
  const zooDir = path.join(outDir, '.zoo');
  const manifest = readJson(path.join(zooDir, 'manifest.json'));
  const buildInfo = readJson(path.join(zooDir, 'build.json'), {});
  const staticPlan = readJson(path.join(zooDir, 'static-plan.json'), []);
  const crateDir = path.join(zooDir, 'crate');

  const rpc = o.connection?.rpcEndpoint || rpcUrl(o.cluster);
  const cluster = clusterLabel(o.cluster);
  const connection = o.connection || connect(rpc);
  // The URL heuristic can miss a private mainnet RPC; the genesis hash cannot. Never weakens the guard.
  let mainnet = isMainnet(o.cluster, rpc);
  const genesis = await genesisCluster(connection);
  if (genesis === 'mainnet' && !mainnet) { mainnet = true; log(`note: ${rpc.replace(/\?.*$/, '')} serves mainnet (genesis hash); treating it as mainnet`); }
  const wallet = o.wallet || loadWallet({ keypair: o.keypair });
  const payer = wallet.keypair;
  log(`cluster ${cluster} (${rpc.replace(/\?.*$/, '')}) · payer ${payer.publicKey.toBase58()}${wallet.path ? ` (${wallet.path})` : ''}`);

  // 1. Which SBPF version does the cluster accept, and does the .so match?
  const arch = await detectSbpfArch(connection);
  let soPath = buildInfo.soPath && fs.existsSync(buildInfo.soPath) ? buildInfo.soPath : null;
  const needsRebuild = !soPath || buildInfo.arch !== arch;
  if (needsRebuild && !fs.existsSync(path.join(crateDir, 'Cargo.toml'))) throw new Error(`${crateDir}: no crate; run build first`);

  // 2. Which program? --program <id> → upgrade that one; else the keypair next to the build.
  let programId, programKeypair = null, upgrade = false;
  if (o.programId) {
    programId = new PublicKey(o.programId);
    const info = await getProgramInfo(connection, programId);
    if (!info.exists) {
      const kp = programKeypairFor(zooDir, { create: false });
      if (!kp || !kp.keypair.publicKey.equals(programId)) throw new Error(`program ${programId.toBase58()} does not exist on ${cluster} and its keypair is not at ${zooDir}/program-keypair.json`);
      programKeypair = kp.keypair;
    } else upgrade = true;
  } else {
    const kp = programKeypairFor(zooDir);
    programKeypair = kp.keypair;
    programId = kp.keypair.publicKey;
    if (kp.created) log(`new program keypair → ${kp.path} (keep it: redeploys upgrade this program in place)`);
    const info = await getProgramInfo(connection, programId);
    upgrade = info.exists;
    if (upgrade && info.authority && !info.authority.equals(payer.publicKey)) throw new Error(`program ${programId.toBase58()} exists but its upgrade authority is ${info.authority.toBase58()}, not the payer; pass --keypair for that wallet`);
  }

  // 3. Cost sheet + mainnet guard — before anything is built or spent. The
  //    estimate uses the .so we have (a rebuild for another arch barely moves it).
  const manifestOut = { ...manifest, programId: programId.toBase58(), cluster, rpc: rpc.replace(/\?.*$/, ''), arch, deployedAt: new Date().toISOString() };
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifestOut));
  const knownSoSize = soPath ? fs.statSync(soPath).size : (buildInfo.soSize ?? null);
  let est = await estimateCost({ staticFiles: staticPlan, soSize: knownSoSize, manifestBytes, connection, upgrade });
  log('');
  log(formatCostTable(est));
  log('');
  const balance = await connection.getBalance(payer.publicKey);
  log(`${upgrade ? 'upgrade' : 'deploy'} ${programId.toBase58()} (${knownSoSize == null ? 'not built yet' : knownSoSize.toLocaleString() + ' B, ' + (needsRebuild ? `rebuilding for ${arch}` : arch)}) + ${staticPlan.length} asset(s); payer balance ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (mainnet && !o.yes) throw new Error(`refusing to touch mainnet without --yes (estimated ${est.totalSol.toFixed(4)} SOL locked as rent)`);

  // 4. Rebuild for the cluster's arch if needed, then check the balance against the real size.
  if (needsRebuild) {
    log(soPath ? `built for ${buildInfo.arch}, cluster wants ${arch}: rebuilding` : `no .so in ${zooDir}; building for ${arch}`);
    const r = await runCargoBuildSbf(crateDir, { arch, outDir: path.join(zooDir, 'deploy'), log, cargo: o.cargo });
    if (!r.ok) throw new Error(r.missing ? `cargo-build-sbf is not installed; install with: ${INSTALL_HINT}` : `cargo build-sbf failed: ${r.error}`);
    soPath = r.soPath;
    writeJson(path.join(zooDir, 'build.json'), { ...buildInfo, arch, soPath, soSize: fs.statSync(soPath).size, builtAt: new Date().toISOString() });
  }
  const so = fs.readFileSync(soPath);
  if (so.length !== knownSoSize) est = await estimateCost({ staticFiles: staticPlan, soSize: so.length, manifestBytes, connection, upgrade });
  if (balance < est.totalLamports) throw new Error(`insufficient balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL < ${est.totalSol.toFixed(4)} SOL needed${mainnet ? '' : ' (airdrop: solana airdrop 10 --url ' + rpc + ')'}`);

  // 5. Program.
  const signatures = {};
  let progress = 0;
  const onProgress = (d, n) => { if (d === n || d - progress >= Math.max(1, Math.floor(n / 10))) { progress = d; log(`  program bytes ${d}/${n} chunks`); } };
  const t0 = Date.now();
  if (upgrade) {
    const r = await upgradeProgram(connection, { payer, programId, so, onProgress }).catch((e) => {
      if (/exceeds the program's max data len/.test(String(e?.message))) throw new Error(`${e.message}; to deploy a fresh program remove ${path.join(zooDir, 'program-keypair.json')} and run deploy again`);
      throw e;
    });
    signatures.program = r.signature;
    log(`upgraded ${programId.toBase58()} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.signature})`);
  } else {
    const r = await deployProgram(connection, { payer, programKeypair, so, onProgress, headroom: o.headroom ? Number(o.headroom) : 1 });
    signatures.program = r.signature;
    log(`deployed ${programId.toBase58()} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.signature}); max data len ${r.maxDataLen.toLocaleString()} B`);
  }

  // 6. Assets.
  const assets = { uploaded: 0, skipped: 0, failed: 0, txs: 0 };
  const failures = [];
  if (!o.skipAssets) {
    const t1 = Date.now();
    let done = 0;
    await pool(staticPlan, async (f) => {
      const label = `[${String(++done).padStart(String(staticPlan.length).length)}/${staticPlan.length}] ${f.path}`;
      if (!f.file || !fs.existsSync(f.file)) { assets.failed++; failures.push(`${f.path}: source file missing (${f.file})`); log(`${label} MISSING ${f.file}`); return; }
      const data = fs.readFileSync(f.file);
      try {
        const r = await putAsset(connection, { authority: payer, programId, path: f.path, contentType: f.contentType || 'application/octet-stream', data, force: o.force });
        if (r.skipped) { assets.skipped++; log(`${label} unchanged (${data.length.toLocaleString()} B)`); }
        else { assets.uploaded++; assets.txs += r.txs; log(`${label} ${data.length.toLocaleString()} B in ${r.txs} tx`); }
      } catch (e) {
        assets.failed++; failures.push(`${f.path}: ${e?.message || e}`); log(`${label} FAILED ${String(e?.message || e).split('\n')[0]}`);
      }
    }, { concurrency: o.concurrency || 4 });
    log(`assets: ${assets.uploaded} uploaded, ${assets.skipped} unchanged, ${assets.failed} failed in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }

  // 7. Manifest (always rewritten: it carries deployedAt).
  const mr = await putAsset(connection, { authority: payer, programId, path: MANIFEST_PATH, contentType: MANIFEST_CONTENT_TYPE, data: Buffer.from(JSON.stringify(manifestOut)), force: true });
  const manifestPda = mr.pda.toBase58();
  log(`manifest → ${MANIFEST_PATH} (${manifestPda}, ${manifestBytes.toLocaleString()} B)`);

  const url = `http://127.0.0.1:${DEFAULT_PORT}/`;
  const result = {
    programId: programId.toBase58(), signature: signatures.program || null, signatures, assets, manifestPda, url,
    cluster, rpc, arch, upgraded: upgrade, deployedAt: manifestOut.deployedAt, failures,
  };
  writeJson(path.join(zooDir, 'deploy.json'), { ...result, payer: payer.publicKey.toBase58() });
  log('');
  log(`serve it:  openzoo-transmute serve ${programId.toBase58()} --cluster ${cluster}${wallet.path ? ` --keypair ${wallet.path}` : ''}`);
  log(`then open  ${url}  (explorer at ${url}.zoo/)`);
  if (failures.length) throw Object.assign(new Error(`${failures.length} asset(s) failed to upload:\n  ${failures.join('\n  ')}`), { result });
  return result;
}

/** Rent one asset of `size` bytes would lock on this cluster, in SOL. */
export async function assetRentSol(connection, size, contentType = '') {
  return (await assetRent(connection, size, contentType)) / LAMPORTS_PER_SOL;
}
