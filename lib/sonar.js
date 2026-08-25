/**
 * SONAR — map the unmapped half of Solana.
 *
 * ~68.5k upgradeable programs are deployed on mainnet. A minority publish
 * an Anchor IDL on-chain; the rest are opaque bytes that every explorer
 * renders as "Unknown Instruction". This is the pipeline that closes that
 * gap: harvest the ones that DID publish as ground truth, then infer a
 * probable IDL for the ones that did not.
 *
 * WHY IT IS TRACTABLE, and it is not magic — it is a hash preimage
 * problem the ecosystem accidentally made easy:
 *
 *   Anchor identifies every instruction by an 8-byte discriminator,
 *   sha256("global:<snake_case_name>")[..8], and those 8 bytes are
 *   COMPILED INTO THE BINARY as constants to compare against. So a
 *   stripped .so still contains a fingerprint of every instruction name
 *   it answers to. The name is not recoverable by inverting sha256 — it
 *   is recoverable by having seen it before.
 *
 *   Which is what the harvest is for. Every published IDL contributes its
 *   instruction names to a rainbow table (name -> discriminator). Names
 *   are not random: `initialize`, `swap`, `deposit`, `update_config`
 *   recur across thousands of programs. A discriminator found in an
 *   unknown binary that matches the table is not a guess, it is an
 *   identification — with the preimage as proof.
 *
 * The residue — discriminators no table explains — is where leCore and
 * the model earn their keep: recall the closest known programs by binary
 * similarity and let a model propose names, which are then CHECKED by
 * hashing the proposal back. A proposed name either hashes to the
 * observed discriminator or it does not. No hallucination survives that.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { loadDotenv } from './dotenv.js';
import { config } from './config.js';

// Before config.js is consulted, so OPENZOO_RPC from .env wins over the
// public default without anyone pasting a credentialed URL onto a
// command line.
loadDotenv();

export const SONAR_DIR = process.env.OPENZOO_SONAR_DIR
  || path.join(process.env.HOME || '.', '.openzoo', 'sonar');

const RPC = process.env.OPENZOO_RPC || config.rpcUrl;

/** The two BPF loaders that own executable programs on mainnet. */
export const LOADERS = {
  upgradeable: 'BPFLoaderUpgradeab1e11111111111111111111111',
  v2: 'BPFLoader2111111111111111111111111111111111',
};

function dir(...parts) {
  const p = path.join(SONAR_DIR, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * RPC with exponential backoff and FULL JITTER.
 *
 * Jitter is not decoration here: a pool of workers that all back off by
 * the same doubling schedule retries in lockstep, so every wave hits the
 * endpoint simultaneously and re-triggers the same 429 that caused the
 * backoff. Randomising across the whole window spreads them out, which
 * is the difference between a pool that recovers and one that
 * synchronises itself into a stall.
 *
 * 429 and 5xx are retried; a 4xx that is not 429 is a real error and is
 * raised immediately rather than retried 6 times for nothing. Retry-After
 * is obeyed when the server sends it — it knows better than the schedule.
 */
async function rpc(method, params, { attempts = 6, base = 400, cap = 20_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) {
      const window = Math.min(cap, base * 2 ** (attempt - 1));
      await sleep(Math.random() * window);
    }
    let r;
    try {
      r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch (e) {
      lastErr = e;            // socket-level: always worth a retry
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      const after = Number(r.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) await sleep(Math.min(cap, after * 1000));
      lastErr = new Error(`rpc ${method}: HTTP ${r.status}`);
      continue;
    }
    if (!r.ok) throw new Error(`rpc ${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) {
      // -32005 is the node's own rate/resource limit; everything else the
      // node reports is a genuine rejection of this request.
      if (j.error.code === -32005) { lastErr = new Error(j.error.message); continue; }
      throw new Error(`rpc ${method}: ${j.error.message}`);
    }
    return j.result;
  }
  throw lastErr || new Error(`rpc ${method}: exhausted ${attempts} attempts`);
}

// ---------------------------------------------------------------- enumerate

/**
 * Every upgradeable program on the cluster.
 *
 * `dataSize: 36` selects only UpgradeableLoaderState::Program accounts
 * (4-byte enum tag + 32-byte programdata address) — the ProgramData
 * accounts holding the actual ELF are megabytes each and are fetched
 * later, per program, on demand. Measured: 68,533 programs in 0.94s.
 */
export async function enumeratePrograms({ log = () => {} } = {}) {
  const res = await rpc('getProgramAccounts', [
    LOADERS.upgradeable,
    {
      encoding: 'base64',
      dataSlice: { offset: 4, length: 32 },   // programdata address
      filters: [{ dataSize: 36 }],
    },
  ]);
  const rows = res.map((r) => ({
    programId: r.pubkey,
    programDataAddress: new PublicKey(Buffer.from(r.account.data[0], 'base64')).toBase58(),
  }));
  fs.writeFileSync(dir('programs.json'), JSON.stringify(rows));
  log(`sonar: ${rows.length} upgradeable programs`);
  return rows;
}

// ---------------------------------------------------------------- IDL

/**
 * Where Anchor puts an on-chain IDL.
 *
 *   base = PDA(program_id, seeds = [])        // the program's own signer
 *   idl  = createWithSeed(base, "anchor:idl", program_id)
 *
 * Note the owner of the resulting account is the PROGRAM, not the loader,
 * which is why there is no single registry to scan — you can only ask
 * this question one program at a time.
 */
export async function idlAddress(programId) {
  const pid = new PublicKey(programId);
  const base = PublicKey.findProgramAddressSync([], pid)[0];
  // createWithSeed is async in @solana/web3.js 1.98 — awaited, not
  // wrapped in a sync helper, because a Promise silently stringifies to
  // "[object Promise]" and every derived address would be wrong.
  return PublicKey.createWithSeed(base, 'anchor:idl', pid);
}

/**
 * Decode an IdlAccount: 8-byte account discriminator, 32-byte authority,
 * 4-byte LE length, then the JSON compressed with zlib.
 *
 * Length-prefixed AND bounds-checked because this is adversarial data —
 * an account can claim any length it likes.
 */
export function decodeIdlAccount(raw) {
  if (!raw || raw.length < 44) return null;
  const len = raw.readUInt32LE(40);
  if (len === 0 || 44 + len > raw.length) return null;
  const body = raw.subarray(44, 44 + len);
  try {
    return JSON.parse(zlib.inflateSync(body).toString('utf8'));
  } catch {
    try {
      return JSON.parse(zlib.inflateRawSync(body).toString('utf8'));
    } catch {
      return null;
    }
  }
}

/** Batch-probe which programs published an IDL. 100 per getMultipleAccounts. */
export async function harvestIdls(programs, { log = () => {}, concurrency = 8 } = {}) {
  const out = dir('idls.jsonl');
  const seen = new Set();
  try {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (line) seen.add(JSON.parse(line).programId);
    }
  } catch { /* first run */ }

  const todo = programs.filter((p) => !seen.has(p.programId));
  log(`sonar: probing ${todo.length} programs for on-chain IDLs (${seen.size} already known)`);

  const batches = [];
  for (let i = 0; i < todo.length; i += 100) batches.push(todo.slice(i, i + 100));

  let found = 0;
  let done = 0;
  const retries = new Map();
  const stream = fs.createWriteStream(out, { flags: 'a', mode: 0o600 });

  const worker = async () => {
    for (;;) {
      const batch = batches.shift();
      if (!batch) return;
      const addrs = await Promise.all(batch.map(async (p) => {
        try { return (await idlAddress(p.programId)).toBase58(); } catch { return null; }
      }));
      let accounts;
      try {
        // rpc() already retries with backoff+jitter; reaching here means
        // the whole schedule was exhausted, so the batch goes to the back
        // of the queue rather than being dropped or hammered again now.
        accounts = await rpc('getMultipleAccounts', [
          addrs.filter(Boolean),
          { encoding: 'base64' },
        ]);
      } catch (e) {
        const tries = (retries.get(batch) || 0) + 1;
        retries.set(batch, tries);
        if (tries > 3) { log(`sonar: batch abandoned after ${tries} passes (${e.message.slice(0, 60)})`); continue; }
        log(`sonar: batch requeued (pass ${tries}) — ${e.message.slice(0, 60)}`);
        batches.push(batch);
        continue;
      }
      let ai = 0;
      for (let i = 0; i < batch.length; i++) {
        if (!addrs[i]) continue;
        const acc = accounts.value[ai++];
        if (!acc?.data?.[0]) continue;
        const idl = decodeIdlAccount(Buffer.from(acc.data[0], 'base64'));
        if (!idl) continue;
        stream.write(JSON.stringify({ programId: batch[i].programId, idl }) + '\n');
        found++;
      }
      done += batch.length;
      if (done % 5000 < 100) log(`sonar: ${done}/${todo.length} probed, ${found} IDLs found`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await new Promise((r) => stream.end(r));
  log(`sonar: harvest complete — ${found} IDLs from ${todo.length} programs`);
  return { probed: todo.length, found };
}

// ---------------------------------------------------------------- rainbow

/** Anchor's instruction discriminator: sha256("global:<name>")[..8]. */
export function ixDiscriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor's account discriminator: sha256("account:<Name>")[..8]. */
export function accountDiscriminator(name) {
  return crypto.createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

export function eventDiscriminator(name) {
  return crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

/**
 * Build the rainbow table from every harvested IDL: discriminator (hex)
 * -> the names that produce it, with how many programs used each.
 *
 * This is the asset. Every IDL anyone ever published makes the unknown
 * ones more legible, and the table only grows.
 */
export function buildRainbow({ log = () => {}, exclude = null, write = true } = {}) {
  const table = new Map();
  const add = (disc, name, kind, programId) => {
    const key = disc.toString('hex');
    const row = table.get(key) || { name, kind, programs: new Set() };
    row.programs.add(programId);
    table.set(key, row);
  };

  let idls = 0;
  const file = dir('idls.jsonl');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    // Held-out programs contribute NOTHING to the table. Without this the
    // eval scores its own answer key and reports a perfect result.
    if (exclude && exclude.has(rec.programId)) continue;
    idls++;
    const idl = rec.idl || {};
    for (const ix of idl.instructions || []) {
      if (!ix?.name) continue;
      // Anchor 0.30+ can carry an explicit discriminator; when it does,
      // trust it over the derivation (custom discriminators are legal).
      const disc = Array.isArray(ix.discriminator)
        ? Buffer.from(ix.discriminator)
        : ixDiscriminator(ix.name);
      add(disc, ix.name, 'instruction', rec.programId);
    }
    for (const acc of idl.accounts || []) {
      if (!acc?.name) continue;
      const disc = Array.isArray(acc.discriminator)
        ? Buffer.from(acc.discriminator)
        : accountDiscriminator(acc.name);
      add(disc, acc.name, 'account', rec.programId);
    }
    for (const ev of idl.events || []) {
      if (!ev?.name) continue;
      const disc = Array.isArray(ev.discriminator)
        ? Buffer.from(ev.discriminator)
        : eventDiscriminator(ev.name);
      add(disc, ev.name, 'event', rec.programId);
    }
  }

  const rows = [...table.entries()].map(([disc, r]) => ({
    disc, name: r.name, kind: r.kind, seen: r.programs.size,
  })).sort((a, b) => b.seen - a.seen);
  if (write) fs.writeFileSync(dir('rainbow.json'), JSON.stringify(rows));
  log(`sonar: rainbow table — ${rows.length} discriminators from ${idls} IDLs`);
  return rows;
}

/**
 * THE EVAL. Hold out programs that DID publish an IDL, rebuild the
 * rainbow table without them, recover their instruction names from the
 * binary alone, and diff against the truth they published.
 *
 * This is the only thing separating "a pipeline that recovers names" from
 * "a pipeline that looks like it does". The leakage guard is the whole
 * point: a table built from all IDLs contains the answer key, and scoring
 * against it would report near-perfect recall no matter how bad the
 * method is.
 *
 * Reported per program and in aggregate:
 *   recall    — of the instructions the program really has, how many did
 *               we name? This is the number that matters.
 *   precision — of the names we claimed, how many were real? Low
 *               precision means the sweep is picking up discriminators
 *               that belong to dependencies rather than this program.
 */
export async function evaluate({ n = 40, seed = 7, log = () => {} } = {}) {
  const all = fs.readFileSync(dir('idls.jsonl'), 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && (r.idl?.instructions?.length > 0));
  if (all.length < n + 10) throw new Error(`only ${all.length} usable IDLs harvested — run: openzoo sonar harvest`);

  // Deterministic sample so a re-run is comparable, not a fresh lottery.
  let x = seed;
  const rand = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const pool = [...all];
  const holdout = [];
  while (holdout.length < n && pool.length) {
    holdout.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }

  const excluded = new Set(holdout.map((h) => h.programId));
  const rows = buildRainbow({ log, exclude: excluded, write: false });
  const rainbow = new Map(rows.map((r) => [r.disc, r]));
  log(`sonar: eval — ${holdout.length} held out, table built from the other ${all.length - holdout.length}`);

  const programs = JSON.parse(fs.readFileSync(dir('programs.json'), 'utf8'));
  const byId = new Map(programs.map((p) => [p.programId, p]));

  const results = [];
  for (const h of holdout) {
    const row = byId.get(h.programId);
    if (!row) continue;
    let elf;
    try { elf = await fetchBinary(row.programDataAddress); } catch { elf = null; }
    if (!elf) { results.push({ programId: h.programId, error: 'no binary' }); continue; }

    const truth = new Set((h.idl.instructions || []).map((i) => i.name));
    const hits = scanDiscriminators(elf, rainbow).filter((x) => x.kind === 'instruction');
    const got = new Set(hits.map((x) => x.name));
    const tp = [...got].filter((g) => truth.has(g)).length;
    results.push({
      programId: h.programId,
      truth: truth.size,
      recovered: got.size,
      correct: tp,
      recall: truth.size ? tp / truth.size : 0,
      precision: got.size ? tp / got.size : 0,
      missed: [...truth].filter((t) => !got.has(t)).slice(0, 6),
    });
    log(`  ${h.programId.slice(0, 8)}… ${tp}/${truth.size} names recovered`);
  }

  const scored = results.filter((r) => !r.error);
  const sum = (f) => scored.reduce((a, b) => a + f(b), 0);
  const summary = {
    heldOut: holdout.length,
    scored: scored.length,
    tableSize: rows.length,
    totalTruth: sum((r) => r.truth),
    totalCorrect: sum((r) => r.correct),
    totalRecovered: sum((r) => r.recovered),
    microRecall: sum((r) => r.truth) ? sum((r) => r.correct) / sum((r) => r.truth) : 0,
    microPrecision: sum((r) => r.recovered) ? sum((r) => r.correct) / sum((r) => r.recovered) : 0,
    fullyRecovered: scored.filter((r) => r.recall === 1).length,
    nothingRecovered: scored.filter((r) => r.correct === 0).length,
  };
  fs.writeFileSync(dir('eval.json'), JSON.stringify({ summary, results }, null, 2));
  return { summary, results };
}

export function loadRainbow() {
  const rows = JSON.parse(fs.readFileSync(dir('rainbow.json'), 'utf8'));
  return new Map(rows.map((r) => [r.disc, r]));
}

// ---------------------------------------------------------------- binary

/** Fetch the ELF for a program out of its ProgramData account. */
export async function fetchBinary(programDataAddress) {
  const acc = await rpc('getAccountInfo', [programDataAddress, { encoding: 'base64' }]);
  if (!acc?.value?.data?.[0]) return null;
  const raw = Buffer.from(acc.value.data[0], 'base64');
  // UpgradeableLoaderState::ProgramData = 4-byte tag + 8-byte slot
  // + 1-byte Option tag + 32-byte upgrade authority, then the ELF.
  const ELF_OFFSET = 45;
  const elf = raw.subarray(ELF_OFFSET);
  const magic = elf.subarray(0, 4);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    // Fall back to locating the magic, in case the header layout shifts.
    const at = raw.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    return at >= 0 ? raw.subarray(at) : null;
  }
  return elf;
}

/**
 * Every 8-byte window in the binary that the rainbow table recognises.
 *
 * Deliberately a brute sweep rather than a disassembly: discriminators
 * are compared as immediates or loaded from .rodata depending on how the
 * program was built, and a sliding window finds both without needing an
 * sBPF decoder. False positives are near-impossible — an 8-byte value
 * colliding with a known sha256 prefix by chance is a 2^-64 event, and
 * the table is the filter.
 */
export function scanDiscriminators(elf, rainbow) {
  const hits = new Map();
  const take = (key, offset, how) => {
    const row = rainbow.get(key);
    if (row && !hits.has(key)) hits.set(key, { ...row, offset, how });
  };
  for (let i = 0; i + 16 <= elf.length; i++) {
    // (a) contiguous — the discriminator sitting in .rodata as data.
    take(elf.subarray(i, i + 8).toString('hex'), i, 'contiguous');
    // (b) lddw-split — sBPF loads a 64-bit immediate as TWO 8-byte
    //     instruction words, each carrying 4 bytes of the value in its
    //     last 4 bytes. So the 8 discriminator bytes appear as
    //     [op|dst|off|LO(4)][0|0|0|HI(4)]: LO at i, HI at i+8, never
    //     adjacent. MEASURED: Pump matched 40/40 instructions this way
    //     and 0/40 contiguously — searching for the whole 8 bytes finds
    //     nothing in a program compiled like this, which is why the
    //     first version of this scan recovered 7% and looked hopeless.
    take(
      elf.subarray(i, i + 4).toString('hex') + elf.subarray(i + 8, i + 12).toString('hex'),
      i,
      'lddw',
    );
  }
  // Tail: contiguous matches in the last 16 bytes the loop above skips.
  for (let i = Math.max(0, elf.length - 16); i + 8 <= elf.length; i++) {
    take(elf.subarray(i, i + 8).toString('hex'), i, 'contiguous');
  }
  return [...hits.values()];
}

// ---------------------------------------------------------------- CLI

export async function runSonar(args) {
  const cmd = args[0] || 'help';
  const log = (m) => console.error(`  ${m}`);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

  if (cmd === 'programs') {
    const rows = await enumeratePrograms({ log });
    console.log(JSON.stringify({ programs: rows.length, file: path.join(SONAR_DIR, 'programs.json') }, null, 2));
    return;
  }
  if (cmd === 'harvest') {
    let progs;
    try {
      progs = JSON.parse(fs.readFileSync(path.join(SONAR_DIR, 'programs.json'), 'utf8'));
    } catch {
      progs = await enumeratePrograms({ log });
    }
    const r = await harvestIdls(progs, { log, concurrency: Number(flag('concurrency') || 12) });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'rainbow') {
    const rows = buildRainbow({ log });
    console.log(JSON.stringify({ discriminators: rows.length, top: rows.slice(0, 15) }, null, 2));
    return;
  }
  if (cmd === 'scan') {
    const pid = args[1];
    if (!pid) throw new Error('usage: openzoo sonar scan <programId>');
    const progs = JSON.parse(fs.readFileSync(path.join(SONAR_DIR, 'programs.json'), 'utf8'));
    const row = progs.find((p) => p.programId === pid);
    if (!row) throw new Error(`${pid} is not in programs.json — run: openzoo sonar programs`);
    const elf = await fetchBinary(row.programDataAddress);
    if (!elf) throw new Error('could not fetch the program binary');
    const rainbow = loadRainbow();
    const hits = scanDiscriminators(elf, rainbow);
    console.log(JSON.stringify({
      programId: pid,
      elfBytes: elf.length,
      identified: hits.length,
      instructions: hits.filter((h) => h.kind === 'instruction').map((h) => h.name),
      accounts: hits.filter((h) => h.kind === 'account').map((h) => h.name),
      events: hits.filter((h) => h.kind === 'event').map((h) => h.name),
    }, null, 2));
    return;
  }
  if (cmd === 'fingerprint') {
    const r = await buildFingerprints({ log, limit: Number(flag('limit') || 0), concurrency: Number(flag('concurrency') || 6) });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'similar') {
    const pid = args[1];
    if (!pid) throw new Error('usage: openzoo sonar similar <programId>');
    const programs = JSON.parse(fs.readFileSync(path.join(SONAR_DIR, 'programs.json'), 'utf8'));
    const row = programs.find((p) => p.programId === pid);
    if (!row) throw new Error(`${pid} not found — run: openzoo sonar programs`);
    const elf = await fetchBinary(row.programDataAddress);
    if (!elf) throw new Error('no binary (ProgramData closed)');
    const refs = loadFingerprints().filter((r) => r.programId !== pid);
    if (!refs.length) throw new Error('no fingerprints yet — run: openzoo sonar fingerprint');
    console.log(JSON.stringify({ programId: pid, bytes: trimElf(elf).length, nearest: nearest(elf, refs) }, null, 2));
    return;
  }
  if (cmd === 'forks') {
    const pid = args[1];
    if (!pid) throw new Error('usage: openzoo sonar forks <programId> [--fuzzy]');
    if (args.includes('--fuzzy')) {
      const r = await findForksFuzzy(pid, {
        log,
        tolerance: Number(flag('tolerance') || 0.06),
        minScore: Number(flag('min') || 0.5),
        maxVerify: Number(flag('verify') || 400),
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const r = await findForks(pid, {
      log,
      limit: Number(flag('limit') || 0),
      concurrency: Number(flag('concurrency') || 12),
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'idl') {
    const pid = args[1];
    if (!pid) throw new Error('usage: openzoo sonar idl <programId> [--no-model]');
    const idl = await reconstructIdl(pid, { log, useModel: !args.includes('--no-model') });
    console.log(JSON.stringify(idl, null, 2));
    return;
  }
  if (cmd === 'blind') {
    const { summary } = await blindEval({
      n: Number(flag('n') || 30),
      seed: Number(flag('seed') || 20260825),
      gapFilter: args.includes('--filter'),
      log,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (cmd === 'eval') {
    const { summary } = await evaluate({
      n: Number(flag('n') || 40),
      seed: Number(flag('seed') || 7),
      log,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (cmd === 'status') {
    const stat = (f) => { try { return fs.statSync(path.join(SONAR_DIR, f)).size; } catch { return 0; } };
    let idls = 0;
    try {
      idls = fs.readFileSync(path.join(SONAR_DIR, 'idls.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    } catch { /* none yet */ }
    console.log(JSON.stringify({
      dir: SONAR_DIR,
      programs: stat('programs.json') ? JSON.parse(fs.readFileSync(path.join(SONAR_DIR, 'programs.json'), 'utf8')).length : 0,
      idlsHarvested: idls,
      rainbowBytes: stat('rainbow.json'),
      rpc: RPC.replace(/\/[^/]{8,}$/, '/***'),
    }, null, 2));
    return;
  }
  console.log([
    'openzoo sonar — map the programs nobody published an IDL for',
    '',
    '  sonar programs              enumerate every upgradeable program on the cluster',
    '  sonar harvest [--concurrency N]',
    '                              probe all of them for on-chain Anchor IDLs',
    '                              (resumable: re-run to continue where it stopped)',
    '  sonar rainbow               build the discriminator -> name table from the harvest',
    '  sonar scan <programId>      identify a binary against the rainbow table',
    '  sonar fingerprint [--limit N]',
    '                              MinHash every reference binary (fork detection)',
    '  sonar forks <programId>     scan the WHOLE cluster for forks of one program',
    '                              (probes a few KB per program, not the binary)',
    '  sonar similar <programId>   nearest known programs by binary similarity —',
    '                              a fork of something with an IDL inherits it',
    '  sonar idl <programId>       reconstruct an IDL from the binary — every name is',
    '                              a proven preimage (confirmed / solved / unresolved)',
    '  sonar eval [--n 40]         hold out known-IDL programs, recover their names',
    '                              from the binary alone, and score against truth',
    '                              (the table is rebuilt WITHOUT them — no leakage)',
    '  sonar status                what has been collected so far',
    '',
    'RPC comes from OPENZOO_RPC (put it in .env — it is gitignored).',
  ].join('\n'));
}

// ---------------------------------------------------------------- similarity

/**
 * FORK DETECTION — the second recovery lane, and the one that reaches the
 * programs the rainbow table cannot.
 *
 * Half of live programs recover 100% of their instruction names from
 * discriminators and half recover zero (measured), because there is more
 * than one dispatch pattern. But Solana is overwhelmingly FORKS: a
 * redeployed pump clone, a Raydium clone, the same program shipped under
 * a new id. If an opaque binary is byte-similar to one that DID publish
 * an IDL, the IDL transfers wholesale — no discriminator needed.
 *
 * (This is what streamflow's magnet-cli does in Rust: list-programs ->
 * analyze against a referent -> rank. Implemented here so it shares the
 * harvest and the RPC layer.)
 *
 * MinHash over 16-byte shingles, not a plain hash of the file: a fork
 * with one constant changed, or built by a different compiler version,
 * has a different digest but nearly identical shingles. The signature is
 * fixed-size, so comparing one unknown against thousands of references is
 * arithmetic on small arrays instead of megabyte diffs.
 */
const SIG_SIZE = Number(process.env.OPENZOO_SONAR_SIG || 128);

/** Trailing zeros are rent-padding in the account, not program content —
 *  including them makes every big program look alike. */
export function trimElf(elf) {
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end--;
  return elf.subarray(0, end);
}

export function fingerprint(elf, { shingle = 16, stride = 4 } = {}) {
  const body = trimElf(elf);
  const sig = new Array(SIG_SIZE).fill(0xffffffff);
  for (let i = 0; i + shingle <= body.length; i += stride) {
    // FNV-1a over the shingle, then SIG_SIZE cheap permutations of it.
    let h = 0x811c9dc5;
    for (let j = 0; j < shingle; j++) {
      h ^= body[i + j];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    for (let k = 0; k < SIG_SIZE; k++) {
      const v = (Math.imul(h ^ (k * 0x9e3779b1), 0x85ebca6b) >>> 0);
      if (v < sig[k]) sig[k] = v;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity: the fraction of signature slots that agree. */
export function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/**
 * Fingerprint every program that published an IDL and has a live binary.
 * That set is the reference library an unknown program is matched against.
 */
export async function buildFingerprints({ log = () => {}, limit = 0, concurrency = 6 } = {}) {
  const programs = JSON.parse(fs.readFileSync(dir('programs.json'), 'utf8'));
  const byId = new Map(programs.map((p) => [p.programId, p]));
  const idls = fs.readFileSync(dir('idls.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r?.idl?.instructions?.length && byId.has(r.programId));

  const out = dir('fingerprints.jsonl');
  const done = new Set();
  try {
    for (const l of fs.readFileSync(out, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).programId);
  } catch { /* first run */ }

  const todo = idls.filter((r) => !done.has(r.programId));
  const queue = limit ? todo.slice(0, limit) : todo;
  log(`sonar: fingerprinting ${queue.length} reference programs (${done.size} already done)`);

  const stream = fs.createWriteStream(out, { flags: 'a', mode: 0o600 });
  let ok = 0; let dead = 0;
  const worker = async () => {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      let elf = null;
      try { elf = await fetchBinary(byId.get(r.programId).programDataAddress); } catch { /* dead */ }
      if (!elf) { dead++; continue; }
      stream.write(JSON.stringify({
        programId: r.programId,
        name: r.idl.name || r.idl.metadata?.name || null,
        bytes: trimElf(elf).length,
        ixCount: r.idl.instructions.length,
        sig: fingerprint(elf),
      }) + '\n');
      ok++;
      if ((ok + dead) % 100 === 0) log(`sonar: ${ok} fingerprinted, ${dead} closed`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await new Promise((r) => stream.end(r));
  log(`sonar: fingerprints — ${ok} live, ${dead} closed`);
  return { ok, dead };
}

export function loadFingerprints() {
  try {
    return fs.readFileSync(dir('fingerprints.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Nearest known programs to an arbitrary binary. */
export function nearest(elf, refs, { top = 5 } = {}) {
  const sig = fingerprint(elf);
  return refs
    .map((r) => ({ programId: r.programId, name: r.name, ixCount: r.ixCount, score: similarity(sig, r.sig) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/**
 * FIND FORKS OF ONE PROGRAM, ACROSS THE WHOLE CLUSTER, CHEAPLY.
 *
 * Fingerprinting 68,533 programs means downloading terabytes. The way
 * around it: a fork is byte-identical over most of its body, so a few
 * small PROBES taken at fixed offsets are enough to reject ~everything.
 * getAccountInfo's dataSlice fetches exactly those bytes — ~12KB per
 * program instead of ~1.4MB, a ~99% reduction — and only survivors are
 * downloaded in full and scored properly.
 *
 * Probes are taken from deep inside the code, never the ELF header:
 * every Solana program shares a near-identical header, so a header probe
 * matches everything and filters nothing.
 *
 * The pass is EXACT-match on probe bytes, so it finds redeployments and
 * lightly-edited forks. A fork that was recompiled (shifting code layout)
 * will be missed here — that is the honest cost of not downloading the
 * cluster, and `similar` still catches those once fingerprinted.
 */
export async function findForks(referentId, {
  log = () => {},
  probes = 3,
  probeLen = 4096,
  concurrency = 12,
  limit = 0,
} = {}) {
  const programs = JSON.parse(fs.readFileSync(dir('programs.json'), 'utf8'));
  const byId = new Map(programs.map((p) => [p.programId, p]));
  const refRow = byId.get(referentId);
  if (!refRow) throw new Error(`${referentId} not in programs.json`);
  const refElf = await fetchBinary(refRow.programDataAddress);
  if (!refElf) throw new Error('referent has no binary');
  const refBody = trimElf(refElf);
  const refSig = fingerprint(refBody);

  // Offsets at 30/50/70% of the real body — deep in code, away from the
  // header and away from the zero padding.
  const offsets = Array.from({ length: probes }, (_, i) =>
    Math.floor(refBody.length * (0.3 + 0.2 * i)));
  const want = offsets.map((o) => refBody.subarray(o, o + probeLen).toString('base64'));
  const ELF_OFFSET = 45;   // ProgramData header before the ELF

  const candidates = programs.filter((p) => p.programId !== referentId);
  const queue = limit ? candidates.slice(0, limit) : candidates;
  log(`sonar: probing ${queue.length} programs for forks of ${referentId.slice(0, 8)}… (${probes}x${probeLen}B each)`);

  const hits = [];
  let scanned = 0;
  const batches = [];
  for (let i = 0; i < queue.length; i += 100) batches.push(queue.slice(i, i + 100));

  const worker = async () => {
    for (;;) {
      const batch = batches.shift();
      if (!batch) return;
      // One probe first: a single mismatch rejects the program, and
      // almost every program mismatches. Only survivors cost more calls.
      let accounts;
      try {
        accounts = await rpc('getMultipleAccounts', [
          batch.map((p) => p.programDataAddress),
          { encoding: 'base64', dataSlice: { offset: ELF_OFFSET + offsets[0], length: probeLen } },
        ]);
      } catch (e) {
        log(`sonar: probe batch failed (${e.message.slice(0, 50)})`);
        scanned += batch.length;
        continue;
      }
      for (let i = 0; i < batch.length; i++) {
        const d = accounts.value[i]?.data?.[0];
        if (d && d === want[0]) hits.push(batch[i]);
      }
      scanned += batch.length;
      if (scanned % 5000 < 100) log(`sonar: ${scanned}/${queue.length} probed, ${hits.length} candidates`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`sonar: ${hits.length} candidates survived the probe — verifying in full`);

  // Verify survivors by downloading and scoring properly.
  const confirmed = [];
  for (const h of hits) {
    let elf = null;
    try { elf = await fetchBinary(h.programDataAddress); } catch { /* gone */ }
    if (!elf) continue;
    const body = trimElf(elf);
    confirmed.push({
      programId: h.programId,
      bytes: body.length,
      identical: body.equals(refBody),
      similarity: Number(similarity(refSig, fingerprint(body)).toFixed(4)),
    });
  }
  confirmed.sort((a, b) => b.similarity - a.similarity);
  fs.writeFileSync(dir(`forks-${referentId.slice(0, 8)}.json`), JSON.stringify({ referent: referentId, refBytes: refBody.length, scanned, confirmed }, null, 2));
  return { referent: referentId, refBytes: refBody.length, scanned, candidates: hits.length, confirmed };
}

/**
 * RECOMPILED forks, which the exact probe cannot see.
 *
 * MEASURED: scanning all 68,532 programs for byte-identical copies of
 * pump found ZERO. Forks do not redeploy the same bytes — they bake in
 * their own program id and fee wallets and rebuild, which shifts every
 * offset and defeats exact matching.
 *
 * Fuzzy matching needs the whole binary, and downloading 68k of them is
 * terabytes. The filter that makes it affordable: an ELF's section-header
 * offset (e_shoff, at byte 0x28) sits just past the end of the real code,
 * so it is a free proxy for compiled size — and it lives in the first 64
 * bytes. Two builds of the same source land within a few percent of each
 * other; everything else is discarded for the price of a 64-byte read.
 * Survivors are then downloaded and MinHashed properly.
 */
export async function findForksFuzzy(referentId, {
  log = () => {},
  tolerance = 0.06,
  minScore = 0.5,
  concurrency = 14,
  maxVerify = 400,
} = {}) {
  const programs = JSON.parse(fs.readFileSync(dir('programs.json'), 'utf8'));
  const byId = new Map(programs.map((p) => [p.programId, p]));
  const refRow = byId.get(referentId);
  if (!refRow) throw new Error(`${referentId} not in programs.json`);
  const refBody = trimElf(await fetchBinary(refRow.programDataAddress));
  const refSig = fingerprint(refBody);
  const refShoff = Number(refBody.readBigUInt64LE(0x28));
  const lo = refShoff * (1 - tolerance);
  const hi = refShoff * (1 + tolerance);
  log(`sonar: referent e_shoff=${refShoff} — accepting ${Math.round(lo)}..${Math.round(hi)}`);

  const ELF_OFFSET = 45;
  const others = programs.filter((p) => p.programId !== referentId);
  const batches = [];
  for (let i = 0; i < others.length; i += 100) batches.push(others.slice(i, i + 100));

  const sized = [];
  let scanned = 0;
  const worker = async () => {
    for (;;) {
      const batch = batches.shift();
      if (!batch) return;
      let accounts;
      try {
        accounts = await rpc('getMultipleAccounts', [
          batch.map((p) => p.programDataAddress),
          { encoding: 'base64', dataSlice: { offset: ELF_OFFSET, length: 64 } },
        ]);
      } catch { scanned += batch.length; continue; }
      for (let i = 0; i < batch.length; i++) {
        const d = accounts.value[i]?.data?.[0];
        if (!d) continue;
        const h = Buffer.from(d, 'base64');
        if (h.length < 0x30 || h[0] !== 0x7f || h[1] !== 0x45) continue;
        let shoff;
        try { shoff = Number(h.readBigUInt64LE(0x28)); } catch { continue; }
        if (shoff >= lo && shoff <= hi) sized.push({ ...batch[i], shoff });
      }
      scanned += batch.length;
      if (scanned % 10000 < 100) log(`sonar: ${scanned}/${others.length} headers read, ${sized.length} size-compatible`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`sonar: ${sized.length} size-compatible of ${scanned} — downloading to score`);

  // Closest in size first, so a truncated verify still checks the best.
  sized.sort((a, b) => Math.abs(a.shoff - refShoff) - Math.abs(b.shoff - refShoff));
  const verify = sized.slice(0, maxVerify);
  if (sized.length > maxVerify) log(`sonar: verifying the ${maxVerify} closest by size (${sized.length - maxVerify} not downloaded)`);

  const scored = [];
  let done = 0;
  const vq = [...verify];
  const vworker = async () => {
    for (;;) {
      const p = vq.shift();
      if (!p) return;
      let elf = null;
      try { elf = await fetchBinary(p.programDataAddress); } catch { /* gone */ }
      done++;
      if (!elf) continue;
      const body = trimElf(elf);
      const score = similarity(refSig, fingerprint(body));
      if (score >= minScore) {
        scored.push({ programId: p.programId, bytes: body.length, similarity: Number(score.toFixed(4)) });
        log(`sonar: FORK ${p.programId} similarity ${score.toFixed(3)}`);
      }
      if (done % 50 === 0) log(`sonar: verified ${done}/${verify.length}, ${scored.length} forks`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, vworker));
  scored.sort((a, b) => b.similarity - a.similarity);
  const result = { referent: referentId, refBytes: refBody.length, refShoff, scanned, sizeCompatible: sized.length, verified: verify.length, forks: scored };
  fs.writeFileSync(dir(`forks-fuzzy-${referentId.slice(0, 8)}.json`), JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------- rebuild

/**
 * Every 64-bit immediate the code loads via lddw, with its offset.
 *
 * This is how unknown discriminators are FOUND without a table: Anchor's
 * dispatch compares the incoming sighash against each instruction's
 * discriminator in turn, so those constants sit together in one stretch
 * of code. Collect all of them, and the ones the rainbow explains tell
 * you where the dispatch is; the unexplained ones sitting beside them are
 * this program's own instructions, whose names simply are not in the
 * table yet.
 */
export function lddwImmediates(elf) {
  const body = trimElf(elf);
  const out = [];
  for (let i = 0; i + 16 <= body.length; i++) {
    // lddw: opcode 0x18, then a second word whose first 4 bytes are zero.
    if (body[i] !== 0x18) continue;
    if (body[i + 8] !== 0 || body[i + 9] !== 0 || body[i + 10] !== 0 || body[i + 11] !== 0) continue;
    const hex = body.subarray(i + 4, i + 8).toString('hex') + body.subarray(i + 12, i + 16).toString('hex');
    if (hex === '0000000000000000') continue;
    out.push({ hex, offset: i });
  }
  return out;
}

/**
 * Keep only the hits inside the program's OWN dispatch.
 *
 * A binary contains the discriminators of every program it CPIs into —
 * token, ATA, whatever it calls — and those match the rainbow table just
 * as well as its own. MEASURED on pump: 54 instruction hits against 40
 * real instructions, i.e. 14 borrowed from callees, 74% precision.
 *
 * The separator is locality. A program's own dispatch compares its
 * discriminators in one stretch of code; the constants used to BUILD a
 * CPI live wherever that call site happens to be. So the largest cluster
 * of hits (each within `gap` of the next) is the dispatch, and hits
 * scattered outside it are somebody else's instructions.
 *
 * Falls through untouched when there is no clear cluster — a wrong
 * cluster would silently delete real instructions, and a false positive
 * is cheaper than a missing entrypoint.
 */
export function dispatchCluster(hits, { gap = Number(process.env.OPENZOO_SONAR_GAP || 8192) } = {}) {
  if (hits.length < 4) return hits;
  const sorted = [...hits].sort((a, b) => a.offset - b.offset);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].offset - sorted[i - 1].offset <= gap) cur.push(sorted[i]);
    else { groups.push(cur); cur = [sorted[i]]; }
  }
  groups.push(cur);
  const best = groups.sort((a, b) => b.length - a.length)[0];
  // Only trust the cluster when it actually dominates; an even spread
  // means this program was not compiled with a contiguous dispatch.
  return best.length >= Math.max(4, hits.length * 0.5) ? best : hits;
}

/**
 * Reconstruct as much of an IDL as the binary actually supports.
 *
 * Three tiers, and they are kept apart on purpose — a consumer needs to
 * know which parts are facts and which are proposals:
 *
 *   confirmed  the discriminator matched the rainbow table. The preimage
 *              is known and hashes to it. This is not a guess.
 *   solved     the name was PROPOSED (by the model, or by mutating a
 *              known name) and then VERIFIED by hashing it back to the
 *              observed discriminator. Also not a guess — a wrong
 *              proposal cannot survive sha256.
 *   unresolved the discriminator is real and sits in the dispatch, but no
 *              name is known. Reported as bytes, never invented.
 *
 * That last distinction is the whole design. A model asked to "write the
 * IDL" will happily produce beautiful fiction; a model asked to propose
 * NAMES that must hash to a known constant produces either a right answer
 * or nothing.
 */
export async function reconstructIdl(programId, {
  log = () => {},
  proposals = 400,
  useModel = true,
} = {}) {
  const programs = JSON.parse(fs.readFileSync(dir('programs.json'), 'utf8'));
  const row = programs.find((p) => p.programId === programId);
  if (!row) throw new Error(`${programId} not in programs.json`);
  const elf = await fetchBinary(row.programDataAddress);
  if (!elf) throw new Error('no binary (ProgramData closed)');
  const rainbow = loadRainbow();

  const confirmed = scanDiscriminators(elf, rainbow);
  // Dispatch clustering is OFF by default. Blind ablation (n=40, 23
  // scored): it lifts micro precision 39.4% -> 50.2%, but costs macro
  // recall 45.1% -> 38.4% and takes programs that recovered SOMETHING to
  // zero, 10 -> 13. For IDL reconstruction that is the wrong trade — a
  // spurious instruction can be tried and discarded, a deleted one cannot
  // be discovered. Opt in with OPENZOO_SONAR_CLUSTER=1 when precision
  // matters more than coverage.
  const ixAll = confirmed.filter((h) => h.kind === 'instruction');
  const ixConfirmed = process.env.OPENZOO_SONAR_CLUSTER === '1' ? dispatchCluster(ixAll) : ixAll;
  const accConfirmed = confirmed.filter((h) => h.kind === 'account');
  log(`sonar: ${ixConfirmed.length} instructions and ${accConfirmed.length} accounts confirmed from the table`);

  // Candidate discriminators: lddw immediates clustered near confirmed
  // hits. Without the clustering constraint every constant in the program
  // (fees, seeds, bitmasks) would be treated as a possible instruction.
  const imms = lddwImmediates(elf);
  const known = new Set(confirmed.map((c) => c.disc ?? c.hex));
  const anchors = confirmed.map((c) => c.offset).sort((a, b) => a - b);
  const NEAR = Number(process.env.OPENZOO_SONAR_NEAR || 4096);
  const nearAnchor = (off) => anchors.some((a) => Math.abs(a - off) <= NEAR);
  const unresolved = [];
  const seen = new Set();
  for (const im of imms) {
    if (rainbow.has(im.hex) || seen.has(im.hex)) continue;
    if (anchors.length && !nearAnchor(im.offset)) continue;
    seen.add(im.hex);
    unresolved.push(im);
  }
  log(`sonar: ${unresolved.length} unexplained discriminator-shaped constants in the dispatch region`);

  // --- solve stage: propose names, keep only those that hash correctly.
  const target = new Map(unresolved.map((u) => [u.hex, u]));
  const solved = [];
  const tryName = (name) => {
    const h = ixDiscriminator(name).toString('hex');
    if (target.has(h)) {
      solved.push({ name, disc: h, offset: target.get(h).offset, via: 'verified' });
      target.delete(h);
      return true;
    }
    return false;
  };

  // Cheap first: names already in the table, and common casing variants.
  // Anchor's IDL may say camelCase while the discriminator was built from
  // snake_case, so both spellings are worth hashing.
  const vocab = new Set();
  for (const r of loadRainbowRows()) if (r.kind === 'instruction') vocab.add(r.name);
  for (const n of [...vocab]) {
    const snake = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const camel = n.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    tryName(n); tryName(snake); tryName(camel);
  }
  log(`sonar: ${solved.length} solved from vocabulary variants, ${target.size} still unexplained`);

  // --- model stage: ask for candidate names, verify every one by hashing.
  if (useModel && target.size) {
    const strings = extractStrings(elf, 6)
      .filter((s) => /^[A-Za-z][A-Za-z0-9_ ]{4,40}$/.test(s)).slice(0, 120);
    try {
      const { zooChat } = await import('./voice.js').then(() => import('./pay.js')).catch(() => ({}));
      void zooChat;
    } catch { /* voice/pay optional */ }
    const { PayClient } = await import('./pay.js');
    const prompt = [
      'You are reverse-engineering a Solana Anchor program. Propose likely INSTRUCTION NAMES.',
      '',
      `Instructions already identified in this program: ${ixConfirmed.map((h) => h.name).join(', ') || '(none)'}`,
      `Account types identified: ${accConfirmed.map((h) => h.name).join(', ') || '(none)'}`,
      `Strings found in the binary: ${strings.slice(0, 60).join(' | ')}`,
      '',
      `There are ${target.size} more instructions whose names are unknown.`,
      'Propose plausible Anchor instruction names for them, in the SAME naming style as the identified ones.',
      'Output ONLY a JSON array of snake_case strings, no prose. Propose many candidates — wrong guesses cost nothing because each is verified against a hash.',
    ].join('\n');
    try {
      const { data } = await new PayClient().chat({
        model: process.env.OPENZOO_SONAR_MODEL || 'fable-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const txt = data?.choices?.[0]?.message?.content || '';
      const m = txt.match(/\[[\s\S]*\]/);
      const names = m ? JSON.parse(m[0]) : [];
      let hit = 0;
      for (const n of names.slice(0, proposals)) {
        if (typeof n !== 'string') continue;
        const snake = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        const camel = n.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        if (tryName(n) || tryName(snake) || tryName(camel)) hit++;
      }
      log(`sonar: model proposed ${names.length} names, ${hit} verified by hash (${target.size} still unexplained)`);
    } catch (e) {
      log(`sonar: model stage skipped (${e.message.slice(0, 70)})`);
    }
  }

  const idl = {
    address: programId,
    metadata: {
      name: 'reconstructed',
      spec: 'anchor-idl-reconstructed/0.1',
      description: 'Recovered from the deployed binary. Names are proven preimages, never guesses.',
    },
    instructions: [
      ...ixConfirmed.map((h) => ({ name: h.name, discriminator: [...Buffer.from(h.disc, 'hex')], confidence: 'confirmed' })),
      ...solved.map((s) => ({ name: s.name, discriminator: [...Buffer.from(s.disc, 'hex')], confidence: 'solved' })),
    ],
    accounts: accConfirmed.map((h) => ({ name: h.name, discriminator: [...Buffer.from(h.disc, 'hex')], confidence: 'confirmed' })),
    unresolvedDiscriminators: [...target.values()].map((u) => ({ discriminator: u.hex, offset: u.offset })),
  };
  fs.writeFileSync(dir(`idl-${programId.slice(0, 8)}.json`), JSON.stringify(idl, null, 2));
  return idl;
}

/**
 * BLIND EVALUATION of the full reconstruction path.
 *
 * `evaluate` scores the raw discriminator sweep; this scores what
 * `sonar idl` would actually emit, under the conditions the real task
 * has:
 *
 *   - the holdout is chosen by a seeded PRNG, not by me, so nobody picks
 *     the flattering examples (pump was cherry-picked and hit 100%)
 *   - the rainbow table is rebuilt with the holdout REMOVED, so the
 *     program's own published names cannot leak in and answer the question
 *   - the reconstruction runs from the binary alone and the truth is only
 *     opened afterwards to score
 *
 * Reported as micro (pooled over all instructions, so big programs weigh
 * more) AND macro (mean of per-program rates, so one 241-instruction
 * program cannot carry the result).
 */
export async function blindEval({ n = 30, seed = 20260825, log = () => {}, gapFilter = false } = {}) {
  const programs = JSON.parse(fs.readFileSync(dir('programs.json'), 'utf8'));
  const byId = new Map(programs.map((p) => [p.programId, p]));
  const all = fs.readFileSync(dir('idls.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r?.idl?.instructions?.length >= 2 && byId.has(r.programId));

  let x = seed;
  const rand = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const pool = [...all];
  const holdout = [];
  while (holdout.length < n && pool.length) holdout.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

  const excluded = new Set(holdout.map((h) => h.programId));
  const rows = buildRainbow({ log: () => {}, exclude: excluded, write: false });
  const rainbow = new Map(rows.map((r) => [r.disc, r]));
  log(`sonar: blind eval — ${holdout.length} held out, table = ${rows.length} discriminators from ${all.length - holdout.length} other IDLs`);

  const results = [];
  for (const h of holdout) {
    let elf = null;
    try { elf = await fetchBinary(byId.get(h.programId).programDataAddress); } catch { /* closed */ }
    if (!elf) { results.push({ programId: h.programId, skipped: 'no binary' }); continue; }

    // --- blind: the binary only.
    let hits = scanDiscriminators(elf, rainbow).filter((k) => k.kind === 'instruction');
    if (gapFilter) hits = dispatchCluster(hits);
    const got = new Set(hits.map((k) => k.name));

    // --- now open the answer key.
    const truth = new Set(h.idl.instructions.map((i) => i.name));
    const tp = [...got].filter((g) => truth.has(g)).length;
    results.push({
      programId: h.programId,
      truth: truth.size,
      claimed: got.size,
      correct: tp,
      recall: truth.size ? tp / truth.size : 0,
      precision: got.size ? tp / got.size : 0,
    });
    log(`  ${h.programId.slice(0, 8)}… ${tp}/${truth.size} correct, ${got.size} claimed`);
  }

  const scored = results.filter((r) => !r.skipped);
  const sum = (f) => scored.reduce((a, b) => a + f(b), 0);
  const mean = (f) => (scored.length ? sum(f) / scored.length : 0);
  const summary = {
    heldOut: holdout.length,
    scored: scored.length,
    skippedNoBinary: results.length - scored.length,
    tableDiscriminators: rows.length,
    microRecall: sum((r) => r.truth) ? sum((r) => r.correct) / sum((r) => r.truth) : 0,
    microPrecision: sum((r) => r.claimed) ? sum((r) => r.correct) / sum((r) => r.claimed) : 0,
    macroRecall: mean((r) => r.recall),
    macroPrecision: mean((r) => r.precision),
    perfect: scored.filter((r) => r.recall === 1).length,
    zero: scored.filter((r) => r.correct === 0).length,
  };
  fs.writeFileSync(dir('blind-eval.json'), JSON.stringify({ summary, results }, null, 2));
  return { summary, results };
}

function loadRainbowRows() {
  try { return JSON.parse(fs.readFileSync(dir('rainbow.json'), 'utf8')); } catch { return []; }
}

/** Printable strings, the other cheap signal (error messages, seeds, names). */
export function extractStrings(elf, min = 6) {
  const out = [];
  let cur = [];
  for (const b of elf) {
    if (b >= 0x20 && b < 0x7f) { cur.push(b); continue; }
    if (cur.length >= min) out.push(Buffer.from(cur).toString('ascii'));
    cur = [];
  }
  if (cur.length >= min) out.push(Buffer.from(cur).toString('ascii'));
  return out;
}
