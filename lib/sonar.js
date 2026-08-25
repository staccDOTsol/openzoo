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
    '  sonar eval [--n 40]         hold out known-IDL programs, recover their names',
    '                              from the binary alone, and score against truth',
    '                              (the table is rebuilt WITHOUT them — no leakage)',
    '  sonar status                what has been collected so far',
    '',
    'RPC comes from OPENZOO_RPC (put it in .env — it is gitignored).',
  ].join('\n'));
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
