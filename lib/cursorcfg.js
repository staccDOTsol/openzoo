/**
 * Write Cursor / VS Code-fork provider settings directly.
 *
 * These live as PLAIN JSON in the editor's globalStorage SQLite (`state.vscdb`,
 * table ItemTable), under the reactive-storage `applicationUser` blob — NOT in
 * an encrypted store. The fields that matter:
 *   openAIBaseUrl        the "Override OpenAI Base URL" box
 *   useOpenAIKey         the toggle next to it
 *   availableAPIKeyModels  the custom model names the picker offers
 *
 * So the whole "paste these four things into Settings" ritual is scriptable,
 * and `openzoo cursor` should just do it. The editor must be CLOSED while we
 * write, or it will overwrite us from memory on exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

const STORAGE = {
  cursor: path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  vscode: path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb'),
};

/** Linux/Windows put globalStorage elsewhere; resolve per platform. */
function storagePath(which) {
  if (process.platform === 'darwin') return STORAGE[which];
  const dir = which === 'vscode' ? 'Code' : 'Cursor';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), dir, 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', dir, 'User', 'globalStorage', 'state.vscdb');
}

const sqlite = (db, sql) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** True when the editor process is running — writing under it gets clobbered. */
export function editorRunning(which) {
  try {
    const name = which === 'vscode' ? 'Visual Studio Code' : 'Cursor';
    const out = execFileSync('pgrep', ['-f', name], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch { return false; }
}

/**
 * Point the editor at the zoo: base URL, key toggle, and the models the picker
 * should offer. Returns what changed, or null when the store is unavailable
 * (a fresh install with no globalStorage yet).
 */
export function writeEditorProviderConfig(which, { baseUrl, models }) {
  const db = storagePath(which);
  if (!fs.existsSync(db)) return null;
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); } catch { return { error: 'sqlite3 not available' }; }

  const raw = sqlite(db, `SELECT value FROM ItemTable WHERE key='${KEY}';`).trim();
  if (!raw) return null;
  let doc;
  try { doc = JSON.parse(raw); } catch { return { error: 'could not parse editor config' }; }

  const before = { openAIBaseUrl: doc.openAIBaseUrl, models: (doc.availableAPIKeyModels || []).length };
  doc.openAIBaseUrl = baseUrl;
  doc.useOpenAIKey = true;
  // Merge, don't clobber: a user may have their own custom models listed.
  const existing = Array.isArray(doc.availableAPIKeyModels) ? doc.availableAPIKeyModels : [];
  const names = new Set(existing.map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean));
  const added = [];
  for (const m of models) {
    if (names.has(m)) continue;
    // Match the shape already present, so the picker renders it correctly.
    existing.push(typeof existing[0] === 'string' ? m : { name: m, defaultOn: true, supportsAgent: true });
    names.add(m);
    added.push(m);
  }
  doc.availableAPIKeyModels = existing;

  // Single-quote escaping for the SQL literal.
  const json = JSON.stringify(doc).replace(/'/g, "''");
  sqlite(db, `UPDATE ItemTable SET value='${json}' WHERE key='${KEY}';`);
  return { db, before, baseUrl, added };
}
