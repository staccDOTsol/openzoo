// Everything that touches the chain: program deploy through the BPF
// upgradeable loader (pure JS, no `solana` CLI needed), asset/manifest
// writes, and the invoke loop with KV account discovery.
import {
  Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  BPF_LOADER_UPGRADEABLE, ERR_KV_MISSING, encodeInvoke, parseLogs, decodeResponse, programDataPda,
  assetPda, encodeAssetInit, encodeAssetWrite, encodeAssetClose, decodeAsset, ASSET_FIXED_HEADER,
  ASSET_MAX_INITIAL, kvPda, decodeKv, MANIFEST_PATH,
  sitePda, assetPdaFor, kvPdaFor, encodeSiteInit, encodeVmInvoke, encodeVmAssetInit, encodeVmAssetWrite, encodeVmAssetClose,
  decodeSite, CODE_PATH,
} from './wire.js';

export const WRITE_CHUNK = 900;
export const DEFAULT_CU = 400_000;
export const DEFAULT_HEAP = 256 * 1024;

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

export function connect(url, commitment = 'confirmed') {
  return new Connection(url, { commitment, confirmTransactionInitialTimeout: 90_000 });
}

async function withRetry(fn, { tries = 5, label = 'tx' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String(e?.message || e);
      // Program errors are final; network/blockhash errors retry.
      if (/custom program error|InstructionError|insufficient funds|invalid account data/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`${label}: ${last?.message || last}`);
}

export async function sendTx(connection, ixs, signers, { computeUnits, heap, label } = {}) {
  return withRetry(async () => {
    const tx = new Transaction();
    if (heap) tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: heap }));
    if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
    for (const ix of ixs) tx.add(ix);
    return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed', skipPreflight: false });
  }, { label });
}

/** Run `n` tasks with bounded concurrency. */
export async function pool(items, worker, { concurrency = 8, onProgress } = {}) {
  let next = 0, done = 0;
  const results = new Array(items.length);
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      done++;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

// ---------------------------------------------------------------- program deploy

export async function getProgramInfo(connection, programId) {
  const pid = new PublicKey(programId);
  const programData = programDataPda(pid);
  const [prog, pd] = await connection.getMultipleAccountsInfo([pid, programData]);
  if (!prog) return { exists: false, programId: pid, programData };
  let authority = null, slot = null, dataLen = null;
  if (pd && pd.data.length >= 45 && pd.data.readUInt32LE(0) === 3) {
    slot = Number(pd.data.readBigUInt64LE(4));
    if (pd.data[12] === 1) authority = new PublicKey(pd.data.subarray(13, 45));
    dataLen = pd.data.length - 45;
  }
  return { exists: true, programId: pid, programData, authority, slot, maxDataLen: dataLen, executable: prog.executable };
}

async function writeBuffer(connection, payer, authority, so, { onProgress } = {}) {
  const buffer = Keypair.generate();
  const space = 37 + so.length;
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  await sendTx(connection, [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: buffer.publicKey, lamports, space, programId: BPF_LOADER_UPGRADEABLE }),
    new TransactionInstruction({
      programId: BPF_LOADER_UPGRADEABLE,
      keys: [{ pubkey: buffer.publicKey, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: false, isWritable: false }],
      data: u32(0),
    }),
  ], [payer, buffer], { label: 'create buffer' });
  const chunks = [];
  for (let off = 0; off < so.length; off += WRITE_CHUNK) chunks.push(off);
  await pool(chunks, (off) => sendTx(connection, [new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [{ pubkey: buffer.publicKey, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.concat([u32(1), u32(off), u64(Math.min(WRITE_CHUNK, so.length - off)), so.subarray(off, off + WRITE_CHUNK)]),
  })], authority.publicKey.equals(payer.publicKey) ? [payer] : [payer, authority], { label: `write ${off}` }), { onProgress });
  return buffer;
}

/**
 * Deploy `so` as a new upgradeable program. Returns {programId, signature}.
 * `maxDataLen` defaults to the binary's exact size (rent is per byte; an
 * upgrade that grows the program redeploys to a new id). Pass `headroom`
 * (a multiplier) or `maxDataLen` to reserve room for in-place upgrades.
 */
export async function deployProgram(connection, { payer, authority = payer, programKeypair = Keypair.generate(), so, maxDataLen, headroom = 1, onProgress }) {
  const buffer = await writeBuffer(connection, payer, authority, so, { onProgress });
  const programLamports = await connection.getMinimumBalanceForRentExemption(36);
  const max = maxDataLen || Math.ceil(so.length * Math.max(1, headroom));
  const programData = programDataPda(programKeypair.publicKey);
  const sig = await sendTx(connection, [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: programKeypair.publicKey, lamports: programLamports, space: 36, programId: BPF_LOADER_UPGRADEABLE }),
    new TransactionInstruction({
      programId: BPF_LOADER_UPGRADEABLE,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: programKeypair.publicKey, isSigner: false, isWritable: true },
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([u32(2), u64(max)]),
    }),
  ], authority.publicKey.equals(payer.publicKey) ? [payer, programKeypair] : [payer, programKeypair, authority], { label: 'deploy' });
  await waitForProgram(connection, programKeypair.publicKey);
  return { programId: programKeypair.publicKey, signature: sig, maxDataLen: max };
}

export async function upgradeProgram(connection, { payer, authority = payer, programId, so, onProgress }) {
  const info = await getProgramInfo(connection, programId);
  if (!info.exists) throw new Error(`program ${programId} does not exist; deploy first`);
  if (!info.authority) throw new Error(`program ${programId} is immutable (authority burned)`);
  if (!info.authority.equals(authority.publicKey)) throw new Error(`upgrade authority is ${info.authority.toBase58()}, signer is ${authority.publicKey.toBase58()}`);
  if (so.length > info.maxDataLen) throw new Error(`binary (${so.length} B) exceeds the program's max data len (${info.maxDataLen} B); redeploy to a new program id`);
  const buffer = await writeBuffer(connection, payer, authority, so, { onProgress });
  const sig = await sendTx(connection, [new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [
      { pubkey: info.programData, isSigner: false, isWritable: true },
      { pubkey: info.programId, isSigner: false, isWritable: true },
      { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: u32(3),
  })], authority.publicKey.equals(payer.publicKey) ? [payer] : [payer, authority], { label: 'upgrade' });
  await waitForProgram(connection, info.programId);
  return { programId: info.programId, signature: sig };
}

// ---------------------------------------------------------------- assets

function assetKeys(authority, programId, pda, site = null) {
  return [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    // proof of authority: the program's ProgramData (compiled site) or the site account (shared runtime)
    { pubkey: site ? sitePda(programId, site)[0] : programDataPda(programId), isSigner: false, isWritable: false },
    { pubkey: pda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

/** Rent (lamports) an asset of `len` bytes will lock, per the cluster's rent params. */
export async function assetRent(connection, len, contentType = '') {
  return connection.getMinimumBalanceForRentExemption(ASSET_FIXED_HEADER + contentType.length + len);
}

/**
 * Upload one asset (create/re-init + chunked writes). Skips the upload when
 * the on-chain bytes already match.
 */
export async function putAsset(connection, { authority, programId, site = null, path, contentType, data, onProgress, force = false }) {
  const pid = new PublicKey(programId);
  const [pda] = assetPdaFor(pid, site, path);
  const initData = site ? encodeVmAssetInit(site, path, data.length, contentType) : encodeAssetInit(path, data.length, contentType);
  // The shared-runtime write carries the 32-byte site id; keep the tx ≤ 1232 B.
  const chunk = site ? WRITE_CHUNK - 32 : WRITE_CHUNK;
  const writeData = (off) => site ? encodeVmAssetWrite(site, path, off, data.subarray(off, off + chunk)) : encodeAssetWrite(path, off, data.subarray(off, off + chunk));
  const existing = await connection.getAccountInfo(pda);
  if (existing && !force) {
    const cur = decodeAsset(existing.data);
    if (cur && cur.complete && cur.contentType === contentType && cur.data.equals(data)) return { pda, skipped: true };
  }
  const keys = assetKeys(authority, pid, pda, site);
  await sendTx(connection, [new TransactionInstruction({ programId: pid, keys, data: initData })], [authority], { label: `init ${path}` });
  const header = ASSET_FIXED_HEADER + Buffer.byteLength(contentType.slice(0, 120));
  // The first `ASSET_MAX_INITIAL - header` bytes fit in the created account;
  // later chunks grow it ≤10 KB per tx. Both are just sequential offsets.
  const chunks = [];
  for (let off = 0; off < data.length; off += chunk) chunks.push(off);
  // Writes past the initial allocation resize the account, and a resize's
  // budget is measured from the length at instruction entry; keep those in
  // order so no two growing writes race each other.
  const initialCap = Math.max(0, ASSET_MAX_INITIAL - header);
  const inPlace = chunks.filter((o) => o + chunk <= initialCap);
  const growing = chunks.filter((o) => o + chunk > initialCap);
  const write = (off) => sendTx(connection, [new TransactionInstruction({ programId: pid, keys, data: writeData(off) })], [authority], { label: `write ${path}@${off}` });
  let done = 0;
  await pool(inPlace, async (off) => { await write(off); onProgress?.(++done, chunks.length); }, { concurrency: 8 });
  for (const off of growing) { await write(off); onProgress?.(++done, chunks.length); }
  return { pda, skipped: false, txs: 1 + chunks.length };
}

export async function closeAsset(connection, { authority, programId, site = null, path }) {
  const pid = new PublicKey(programId);
  const [pda] = assetPdaFor(pid, site, path);
  return sendTx(connection, [new TransactionInstruction({ programId: pid, keys: assetKeys(authority, pid, pda, site), data: site ? encodeVmAssetClose(site, path) : encodeAssetClose(path) })], [authority], { label: `close ${path}` });
}

export async function readAsset(connection, programId, path, site = null) {
  const [pda] = assetPdaFor(new PublicKey(programId), site, path);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeAsset(info.data);
}

export async function readManifest(connection, programId, site = null) {
  const a = await readAsset(connection, programId, MANIFEST_PATH, site);
  if (!a || !a.complete) return null;
  return JSON.parse(a.data.toString('utf8'));
}

export async function readKv(connection, programId, key, site = null) {
  const [pda] = kvPdaFor(new PublicKey(programId), site, key);
  const info = await connection.getAccountInfo(pda);
  return info ? decodeKv(info.data) : null;
}

// ---------------------------------------------------------------- invoke

/**
 * Run one bridge Invoke event against a site program.
 *
 * Reads (`mutate: false`) are `simulateTransaction` calls — free, no
 * signature. Writes send a real transaction signed by `payer`. In both cases
 * KV accounts the handler touches are discovered by dry-running: the program
 * logs `ZOOK <pda>` for each missing account and fails with ERR_KV_MISSING,
 * we append them and retry.
 *
 * @returns {{status:number, headers:object, body:Buffer, signature?:string, logs:string[], unitsConsumed?:number, accounts:string[]}}
 */
export async function invoke(connection, { programId, site = null, payer, event, mutate = false, computeUnits = DEFAULT_CU, heap = DEFAULT_HEAP, maxDiscovery = 6 }) {
  const pid = new PublicKey(programId);
  const payerKey = payer.publicKey ?? new PublicKey(payer);
  // Shared runtime: the instruction names the site and hands the program its
  // site account and code account after payer + system program.
  const siteKeys = site ? [
    { pubkey: sitePda(pid, site)[0], isSigner: false, isWritable: false },
    { pubkey: assetPdaFor(pid, site, CODE_PATH)[0], isSigner: false, isWritable: false },
  ] : [];
  if (mutate) {
    // Identical bytes inside one blockhash window dedupe as AlreadyProcessed;
    // a per-request nonce header (ignored on chain) makes every write unique
    // and doubles as a request id in the logs.
    const nonce = Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
    event = { ...event, headers: typeof event.headers === 'string' ? event.headers + `x-zoo-nonce:${nonce}\n` : { ...(event.headers || {}), 'x-zoo-nonce': nonce } };
  }
  const data = site ? encodeVmInvoke(site, event) : encodeInvoke(event);
  const extra = [];
  for (let round = 0; ; round++) {
    const keys = [
      { pubkey: payerKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...siteKeys,
      ...extra.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })),
    ];
    const ix = new TransactionInstruction({ programId: pid, keys, data });
    const tx = new Transaction();
    if (heap) tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: heap }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
    tx.add(ix);
    tx.feePayer = payerKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    const sim = await connection.simulateTransaction(tx, undefined, false);
    const v = sim.value;
    const logs = v.logs || [];
    const parsed = parseLogs(logs, v.returnData);
    const custom = customError(v.err);
    if (custom === ERR_KV_MISSING) {
      if (round >= maxDiscovery) throw new Error(`KV discovery did not converge after ${round} rounds`);
      const fresh = parsed.missing.filter((m) => !extra.some((e) => e.equals(m)));
      if (!fresh.length) throw new Error('program reported missing KV accounts but logged none');
      extra.push(...fresh);
      continue;
    }
    if (v.err) {
      const e = new Error(`program failed: ${JSON.stringify(v.err)}\n${logs.join('\n')}`);
      e.logs = logs; e.err = v.err;
      throw e;
    }
    if (!parsed.bytes) throw new Error(`no response emitted\n${logs.join('\n')}`);
    const resp = decodeResponse(parsed.bytes);
    const out = { ...resp, logs, unitsConsumed: v.unitsConsumed, accounts: extra.map((k) => k.toBase58()), simulated: true };
    if (!mutate) return out;
    if (!payer.secretKey) throw new Error('a signing keypair is required for mutating requests');
    // Real send: same accounts, fresh blockhash. The response is read back
    // from the confirmed transaction's logs so it reflects committed state.
    const sig = await sendTx(connection, [ix], [payer], { computeUnits, heap, label: `${event.method} ${event.path}` });
    const conf = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const clogs = conf?.meta?.logMessages || logs;
    const cparsed = parseLogs(clogs, conf?.meta?.returnData);
    const cresp = cparsed.bytes ? decodeResponse(cparsed.bytes) : resp;
    return { ...cresp, signature: sig, logs: clogs, unitsConsumed: conf?.meta?.computeUnitsConsumed, accounts: out.accounts, simulated: false };
  }
}

export function customError(err) {
  if (!err || typeof err !== 'object') return null;
  const ie = err.InstructionError;
  if (!Array.isArray(ie)) return null;
  const inner = ie[1];
  return inner && typeof inner === 'object' && 'Custom' in inner ? inner.Custom : null;
}

// ---------------------------------------------------------------- SBPF arch

/** Feature gates that decide which `cargo build-sbf --arch` a cluster accepts. */
export const FEATURE_SBPF_V3 = new PublicKey('5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC');
export const FEATURE_DISABLE_V0_DEPLOY = new PublicKey('B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g');

/**
 * Pick the SBPF version to build for. Mainnet (Sept 2026) still deploys v0
 * and has not enabled v3; a test validator enables everything and rejects
 * v0. Rule: v3 if the v3 gate is active, else v0.
 */
export async function detectSbpfArch(connection) {
  const [v3, noV0] = await connection.getMultipleAccountsInfo([FEATURE_SBPF_V3, FEATURE_DISABLE_V0_DEPLOY]);
  const active = (a) => !!a && a.data.length >= 9 && a.data[0] === 1;
  if (active(v3)) return 'v3';
  if (active(noV0)) return 'v3';
  return 'v0';
}

/** A (re)deployed program becomes invokable one slot after the deploy slot. */
export async function waitForProgram(connection, programId, { timeoutMs = 30_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const info = await getProgramInfo(connection, programId);
    const slot = await connection.getSlot('confirmed');
    if (info.exists && info.slot != null && slot > info.slot) return info;
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for the program to become invokable');
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---------------------------------------------------------------- shared runtime sites

/** Create the site account (`["site", siteId]`) under the runtime, owned by `authority`. Idempotent. */
export async function initSite(connection, { authority, runtime, site }) {
  const pid = new PublicKey(runtime);
  const [pda] = sitePda(pid, site);
  const info = await connection.getAccountInfo(pda);
  if (info) {
    const s = decodeSite(info.data);
    if (s && !s.authority.equals(authority.publicKey)) throw new Error(`site ${new PublicKey(site).toBase58()} belongs to ${s.authority.toBase58()}`);
    return { pda, created: false };
  }
  await sendTx(connection, [new TransactionInstruction({
    programId: pid,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSiteInit(site),
  })], [authority], { label: 'site init' });
  return { pda, created: true };
}

export async function getSiteInfo(connection, runtime, site) {
  const [pda] = sitePda(new PublicKey(runtime), site);
  const info = await connection.getAccountInfo(pda);
  if (!info) return { exists: false, pda };
  const s = decodeSite(info.data);
  return { exists: !!s, pda, authority: s?.authority || null };
}
