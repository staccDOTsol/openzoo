import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ingestUpload,
  lookupUpload,
  mimeFromBytes,
  readUploadChunk,
  readUploadImage,
  resetUploadStore,
  uploadDir,
} from '../lib/grokbotUploads.js';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test('mimeFromBytes sniffs png and jpeg', () => {
  assert.equal(mimeFromBytes(PNG, 'x.bin'), 'image/png');
  assert.equal(mimeFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'x.bin'), 'image/jpeg');
  assert.equal(mimeFromBytes(Buffer.from('hello'), 'note.txt'), null);
  assert.equal(mimeFromBytes(PNG, 'shot.png'), 'image/png');
});

test('ingestUpload stores bytes and lookup finds the box path', () => {
  const prev = process.env.OZ_GROKBOT_UPLOAD_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-up-'));
  process.env.OZ_GROKBOT_UPLOAD_DIR = dir;
  resetUploadStore();
  try {
    const got = ingestUpload({ filename: 'paste.png', bytes: PNG });
    assert.equal(got.ok, true);
    assert.match(got.path, /^\/openzoo-uploads\/.+\.png$/);
    assert.equal(got.mime, 'image/png');
    assert.equal(got.bytes, PNG.length);
    const rec = lookupUpload(got.path);
    assert.ok(rec);
    assert.equal(rec.buf.equals(PNG), true);
    assert.equal(lookupUpload(path.basename(got.path))?.path, got.path);
    const chunk = readUploadChunk({ path: got.path, offset: 0, length: 0 });
    assert.equal(chunk.totalSize, PNG.length);
    assert.equal(chunk.bytesBase64, '');
    const body = readUploadChunk({ path: got.path, offset: 0, length: 8 });
    assert.equal(Buffer.from(body.bytesBase64, 'base64').equals(PNG.subarray(0, 8)), true);
    const img = readUploadImage(got.path);
    assert.match(img.dataUrl, /^data:image\/png;base64,/);
    assert.equal(uploadDir(), dir);
  } finally {
    resetUploadStore();
    if (prev === undefined) delete process.env.OZ_GROKBOT_UPLOAD_DIR;
    else process.env.OZ_GROKBOT_UPLOAD_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestUpload rejects empty and oversize', () => {
  assert.equal(ingestUpload({ filename: 'x.png', bytes: Buffer.alloc(0) }).reason, 'failed');
  const prev = process.env.OZ_GROKBOT_UPLOAD_MAX;
  process.env.OZ_GROKBOT_UPLOAD_MAX = '4';
  try {
    assert.equal(ingestUpload({ filename: 'x.png', bytes: Buffer.from('hello') }).reason, 'too-large');
  } finally {
    if (prev === undefined) delete process.env.OZ_GROKBOT_UPLOAD_MAX;
    else process.env.OZ_GROKBOT_UPLOAD_MAX = prev;
  }
});
