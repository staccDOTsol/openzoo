// The Vercel node-bridge contract as bytes — mirror of runtime/zoo-host/src/wire.rs.
//
// Vercel's Lambda launcher hands a function `{method, path, headers, body}`
// (the bridge "Invoke" event) and expects `{statusCode, headers, body}`. On
// Solana that event is instruction data and the response is return data plus
// `sol_log_data` chunks. Keep this file and wire.rs in lock-step.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export const TAG = { INVOKE: 0, ASSET_INIT: 1, ASSET_WRITE: 2, ASSET_CLOSE: 3, SITE_INIT: 16, SITE_SET_AUTHORITY: 17, VM_INVOKE: 18, VM_ASSET_INIT: 19, VM_ASSET_WRITE: 20, VM_ASSET_CLOSE: 21 };
/** Path of a site's bytecode module under the shared runtime. */
export const CODE_PATH = '/.zoo/code.bin';
export const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
export const ERR_KV_MISSING = 0x4b560001;
export const ERR_NOT_AUTHORITY = 0x4b560002;
export const ERR_BAD_WIRE = 0x4b560003;
export const MAX_RETURN_DATA = 1024;
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** Headers the gateway forwards on chain (everything else is dropped; a tx is 1232 bytes). */
export const FORWARDED_HEADERS = ['content-type', 'authorization', 'accept', 'cookie', 'user-agent', 'x-forwarded-for', 'x-real-ip', 'x-vercel-id'];

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

export function methodIndex(method) {
  const i = METHODS.indexOf(String(method || 'GET').toUpperCase());
  if (i < 0) throw new Error(`unsupported method ${method}`);
  return i;
}

/** Serialize headers as "name:value\n" with lowercase names, prefix-forwarded only. */
export function encodeHeaders(headers = {}, { forwardAll = false } = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (!forwardAll && !FORWARDED_HEADERS.includes(name) && !name.startsWith('x-')) continue;
    const val = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    if (val.includes('\n')) continue;
    lines.push(`${name}:${val}\n`);
  }
  return lines.join('');
}

/**
 * Build the instruction data for one bridge Invoke event.
 * @param {{route:number, method?:string, path:string, query?:string, headers?:object, body?:Buffer|string}} ev
 */
export function encodeInvoke(ev) {
  const path = Buffer.from(ev.path || '/', 'utf8');
  const query = Buffer.from(ev.query || '', 'utf8');
  const headers = Buffer.from(typeof ev.headers === 'string' ? ev.headers : encodeHeaders(ev.headers), 'utf8');
  const body = ev.body == null ? Buffer.alloc(0) : Buffer.isBuffer(ev.body) ? ev.body : Buffer.from(String(ev.body), 'utf8');
  if (ev.route < 0 || ev.route > 255) throw new Error('route index out of range');
  return Buffer.concat([
    Buffer.from([TAG.INVOKE, ev.route, methodIndex(ev.method)]),
    u16(path.length), path,
    u16(query.length), query,
    u16(headers.length), headers,
    u32(body.length), body,
  ]);
}

/** Decode the bridge response bytes into {status, headers, body}. */
export function decodeResponse(buf) {
  let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error('short response'); };
  need(2); const status = buf.readUInt16LE(i); i += 2;
  need(2); const hl = buf.readUInt16LE(i); i += 2;
  need(hl); const hdr = buf.subarray(i, i + hl).toString('utf8'); i += hl;
  need(4); const bl = buf.readUInt32LE(i); i += 4;
  need(bl); const body = buf.subarray(i, i + bl); i += bl;
  const headers = {};
  for (const line of hdr.split('\n')) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c)] = line.slice(c + 1);
  }
  return { status, headers, body };
}

/**
 * Reassemble a response from simulateTransaction/getTransaction logs.
 * Prefers the `ZOOR` log chunks; falls back to `returnData` (≤1024 bytes).
 * Also collects `ZOOK` (missing KV account) lines.
 */
export function parseLogs(logs = [], returnData = null) {
  const chunks = new Map();
  const missing = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const parts = line.slice('Program data: '.length).split(' ').map((p) => Buffer.from(p, 'base64'));
    const tag = parts[0]?.toString('latin1');
    if (tag === 'ZOOR' && parts.length >= 2) {
      const idx = parts[1].length >= 2 ? parts[1].readUInt16LE(0) : 0;
      chunks.set(idx, parts[2] ?? Buffer.alloc(0));
    } else if (tag === 'ZOOK' && parts[1]?.length === 32) {
      missing.push(new PublicKey(parts[1]));
    }
  }
  let bytes = null;
  if (chunks.size) {
    const ordered = [...chunks.keys()].sort((a, b) => a - b).map((k) => chunks.get(k));
    bytes = Buffer.concat(ordered);
  } else if (returnData?.data) {
    bytes = Buffer.from(returnData.data[0], returnData.data[1] || 'base64');
  }
  return { bytes, missing, truncated: bytes == null ? false : (!chunks.size && bytes.length >= MAX_RETURN_DATA) };
}

// ---- PDAs (mirror kv.rs / assets.rs) ----

export function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function kvHash(key) { return sha256(Buffer.from('zoo-kv'), Buffer.from(String(key), 'utf8')); }
export function kvPda(programId, key) {
  return PublicKey.findProgramAddressSync([Buffer.from('kv'), kvHash(key)], new PublicKey(programId));
}

export function assetHash(path) { return sha256(Buffer.from('zoo-asset'), Buffer.from(path, 'utf8')); }
export function assetPda(programId, path) {
  return PublicKey.findProgramAddressSync([Buffer.from('asset'), assetHash(path)], new PublicKey(programId));
}
export function assetPdaFromHash(programId, hash) {
  return PublicKey.findProgramAddressSync([Buffer.from('asset'), hash], new PublicKey(programId));
}

export function programDataPda(programId) {
  return PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
}

/** Reserved path of the site manifest (served publicly, like /.well-known). */
export const MANIFEST_PATH = '/.zoo/manifest.json';

export const ASSET_FIXED_HEADER = 7;
export const ASSET_MAX_INITIAL = 10240;

export function encodeAssetInit(path, totalLen, contentType) {
  const ct = Buffer.from(contentType.slice(0, 120), 'utf8');
  return Buffer.concat([Buffer.from([TAG.ASSET_INIT]), assetHash(path), u32(totalLen), Buffer.from([ct.length]), ct]);
}
export function encodeAssetWrite(path, offset, bytes) {
  return Buffer.concat([Buffer.from([TAG.ASSET_WRITE]), assetHash(path), u32(offset), bytes]);
}
export function encodeAssetClose(path) {
  return Buffer.concat([Buffer.from([TAG.ASSET_CLOSE]), assetHash(path)]);
}

/** Decode an asset account: {total, contentType, data (may be partial), complete}. */
export function decodeAsset(data) {
  if (!data || data.length < ASSET_FIXED_HEADER || data[0] !== 1) return null;
  const total = data.readUInt32LE(2);
  const ctLen = data[6];
  const contentType = data.subarray(7, 7 + ctLen).toString('utf8');
  const start = 7 + ctLen;
  const body = data.subarray(start, Math.min(data.length, start + total));
  return { total, contentType, data: body, complete: body.length === total, bump: data[1] };
}

export const KV_HEADER = 6;
export function decodeKv(data) {
  if (!data || data.length < KV_HEADER || data[0] !== 1) return null;
  const len = data.readUInt32LE(2);
  if (len === 0) return null;
  try { return JSON.parse(data.subarray(KV_HEADER, KV_HEADER + len).toString('utf8')); } catch { return null; }
}

// ---- shared runtime (zoo-vm): sites are accounts namespaced by a 32-byte site id

export function siteIdBytes(site) { return site instanceof PublicKey ? site.toBuffer() : new PublicKey(site).toBuffer(); }

export function sitePda(runtime, site) {
  return PublicKey.findProgramAddressSync([Buffer.from('site'), siteIdBytes(site)], new PublicKey(runtime));
}
export function kvPdaNs(runtime, site, key) {
  return PublicKey.findProgramAddressSync([Buffer.from('kv'), siteIdBytes(site), kvHash(key)], new PublicKey(runtime));
}
export function assetPdaNs(runtime, site, path) {
  return PublicKey.findProgramAddressSync([Buffer.from('asset'), siteIdBytes(site), assetHash(path)], new PublicKey(runtime));
}
/** Any-mode asset PDA: program-flavour when `site` is null. */
export function assetPdaFor(programId, site, path) {
  return site ? assetPdaNs(programId, site, path) : assetPda(programId, path);
}
export function kvPdaFor(programId, site, key) {
  return site ? kvPdaNs(programId, site, key) : kvPda(programId, key);
}

export function encodeSiteInit(site) { return Buffer.concat([Buffer.from([TAG.SITE_INIT]), siteIdBytes(site)]); }
export function encodeSiteSetAuthority(site, newAuthority) { return Buffer.concat([Buffer.from([TAG.SITE_SET_AUTHORITY]), siteIdBytes(site), new PublicKey(newAuthority).toBuffer()]); }
/** The VM invoke: same bridge event, prefixed by the site id. */
export function encodeVmInvoke(site, ev) {
  const inner = encodeInvoke(ev); // [TAG.INVOKE][...]
  return Buffer.concat([Buffer.from([TAG.VM_INVOKE]), siteIdBytes(site), inner.subarray(1)]);
}
export function encodeVmAssetInit(site, path, totalLen, contentType) { return Buffer.concat([Buffer.from([TAG.VM_ASSET_INIT]), siteIdBytes(site), encodeAssetInit(path, totalLen, contentType).subarray(1)]); }
export function encodeVmAssetWrite(site, path, offset, bytes) { return Buffer.concat([Buffer.from([TAG.VM_ASSET_WRITE]), siteIdBytes(site), encodeAssetWrite(path, offset, bytes).subarray(1)]); }
export function encodeVmAssetClose(site, path) { return Buffer.concat([Buffer.from([TAG.VM_ASSET_CLOSE]), siteIdBytes(site), encodeAssetClose(path).subarray(1)]); }

export const SITE_LEN = 66;
/** Decode a site account: { authority, bump } or null. */
export function decodeSite(data) {
  if (!data || data.length < SITE_LEN || data[0] !== 1) return null;
  return { bump: data[1], authority: new PublicKey(data.subarray(2, 34)) };
}
