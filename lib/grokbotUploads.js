/**
 * Grok Bot paste/upload store.
 *
 * Electron stages bytes on disk, then commitStagedAttachments POSTs
 * /api/uploadAttachment {filename, bytesBase64} and requires `.path` on the
 * reply. A stub `{ok:true}` made commit return null → send/attachment-commit-failed
 * → i18n wx1EG9 ("Couldn't send your message. Check your connection").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
const IMAGE_MAGIC = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from('GIF8'), 'image/gif'],
  [Buffer.from([0x52, 0x49, 0x46, 0x46]), 'image/webp'],
];
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
};
function maxBytes() {
  return Number(process.env.OZ_GROKBOT_UPLOAD_MAX || 20 * 1024 * 1024);
}

const store = new Map();

export function uploadDir() {
  return process.env.OZ_GROKBOT_UPLOAD_DIR
    || path.join(os.homedir(), '.openzoo', 'grokbot-uploads');
}

export function mimeFromBytes(buf, p = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (IMAGE_EXT.test(p)) {
    const ext = path.extname(p).toLowerCase();
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  }
  for (const [magic, mime] of IMAGE_MAGIC) {
    if (b.length >= magic.length && b.subarray(0, magic.length).equals(magic)) {
      if (mime === 'image/webp' && b.length >= 12 && b.subarray(8, 12).toString('ascii') !== 'WEBP') {
        continue;
      }
      return mime;
    }
  }
  return null;
}

function safeName(filename) {
  const base = path.basename(String(filename || 'image.png')) || 'image.png';
  const cleaned = base.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '') || 'image.png';
  return cleaned.slice(0, 120);
}

function asBuffer({ bytes, bytesBase64 } = {}) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (typeof bytesBase64 === 'string' && bytesBase64.length) {
    return Buffer.from(bytesBase64, 'base64');
  }
  return null;
}

function remember(rec) {
  store.set(rec.path, rec);
  store.set(rec.abs, rec);
  store.set(path.basename(rec.abs), rec);
  return rec;
}

export function ingestUpload(input = {}) {
  const buf = asBuffer(input);
  if (!buf || !buf.length) return { ok: false, reason: 'failed' };
  if (buf.length > maxBytes()) return { ok: false, reason: 'too-large' };
  const filename = safeName(input.filename);
  const id = randomUUID();
  const rel = `${id}-${filename}`;
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, buf);
  const storedPath = `/openzoo-uploads/${rel}`;
  const mime = mimeFromBytes(buf, filename) || 'application/octet-stream';
  const rec = remember({
    path: storedPath,
    abs,
    filename,
    mime,
    buf,
    bytes: buf.length,
  });
  return { ok: true, path: rec.path, abs: rec.abs, mime: rec.mime, filename: rec.filename, bytes: rec.bytes };
}

export function lookupUpload(p) {
  const s = String(p || '');
  if (!s) return null;
  if (store.has(s)) return store.get(s);
  const base = s.split(/[/\\]/).pop();
  if (base && store.has(base)) return store.get(base);
  try {
    if ((s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) && fs.existsSync(s) && fs.statSync(s).isFile()) {
      const buf = fs.readFileSync(s);
      return {
        path: s,
        abs: s,
        filename: path.basename(s),
        mime: mimeFromBytes(buf, s) || 'application/octet-stream',
        buf,
        bytes: buf.length,
      };
    }
  } catch { /* */ }
  return null;
}

export function readUploadChunk({ path: p, offset = 0, length = 0 } = {}) {
  const rec = lookupUpload(p);
  if (!rec) return null;
  const totalSize = rec.buf.length;
  const off = Math.max(0, Number(offset) || 0);
  const want = Number(length);
  const end = !Number.isFinite(want) || want <= 0 ? off : Math.min(totalSize, off + want);
  const slice = rec.buf.subarray(Math.min(off, totalSize), end);
  return {
    bytesBase64: slice.toString('base64'),
    totalSize,
    mime: rec.mime || null,
  };
}

export function readUploadText(p) {
  const rec = lookupUpload(p);
  if (!rec) return null;
  return { text: rec.buf.toString('utf8') };
}

export function readUploadImage(p) {
  const rec = lookupUpload(p);
  if (!rec) return null;
  const mime = rec.mime && rec.mime.startsWith('image/') ? rec.mime : mimeFromBytes(rec.buf, rec.filename);
  if (!mime || !mime.startsWith('image/')) return null;
  return {
    dataUrl: `data:${mime};base64,${rec.buf.toString('base64')}`,
    mime,
    width: null,
    height: null,
  };
}

/** Test helper — does not delete files on disk. */
export function resetUploadStore() {
  store.clear();
}
