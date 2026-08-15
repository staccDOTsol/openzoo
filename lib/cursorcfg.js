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
    // MATCH THE APP BINARY, NOT THE WORD. `pgrep -f Cursor` matched 19
    // processes on a machine with Cursor CLOSED: this very command
    // (`node openzoo.js cursor` contains the word), leftover crashpad helpers,
    // and macOS's own CursorUIViewService — so it always warned "already
    // running" and told the user to quit an editor that was not open.
    const needle = which === 'vscode'
      ? 'Visual Studio Code.app/Contents/MacOS/'
      : 'Cursor.app/Contents/MacOS/Cursor';
    const out = execFileSync('pgrep', ['-f', needle], { encoding: 'utf8' });
    const pids = out.split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((p) => Number(p) !== process.pid && Number(p) !== process.ppid);
    return pids.length > 0;
  } catch { return false; }
}

/**
 * Quit the editor and wait for it to exit.
 *
 * WHY WE DO THIS FOR THE USER: the editor holds its settings in memory and
 * flushes them on exit, so a write performed while it is running is silently
 * reverted — measured: availableAPIKeyModels came back [] every launch, the
 * model never appeared in the dropdown, and the user was told to "just pick
 * it". Writing while it is CLOSED sticks. Telling a human to quit their editor
 * and re-run a command is not automation, so we quit it, write, and relaunch.
 */
export async function quitEditor(which) {
  if (!editorRunning(which)) return { wasRunning: false };
  const app = which === 'vscode' ? 'Visual Studio Code' : 'Cursor';
  try {
    if (process.platform === 'darwin') {
      // Graceful: ask the app to quit so it flushes state normally.
      execFileSync('osascript', ['-e', `tell application "${app}" to quit`], { stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-TERM', '-f', which === 'vscode' ? 'Code' : 'Cursor'], { stdio: 'ignore' });
    }
  } catch { /* fall through to the wait; it may already be closing */ }
  for (let i = 0; i < 40; i++) {                 // up to 20s
    if (!editorRunning(which)) return { wasRunning: true, quit: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { wasRunning: true, quit: false };
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

  // ALSO register in availableDefaultModels2, which is what the Models UI
  // actually renders. A model present only in availableAPIKeyModels never
  // appears in the picker or the search box ("No models available" for a name
  // that was definitely written) — the one hand-added entry that DID show,
  // `lecore`, lives here with isUserAdded:true. Mirror that shape exactly.
  const defs = Array.isArray(doc.availableDefaultModels2) ? doc.availableDefaultModels2 : [];
  const defNames = new Set(defs.map((m) => m?.name).filter(Boolean));
  for (const m of models) {
    if (defNames.has(m)) continue;
    defs.push({
      name: m,
      defaultOn: true,
      supportsAgent: true,
      degradationStatus: 0,
      supportsThinking: true,
      supportsImages: true,
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      serverModelName: m,
      isRecommendedForBackgroundComposer: false,
      supportsPlanMode: true,
      supportsSandboxing: true,
      isUserAdded: true,
      inputboxShortModelName: m,
      parameterDefinitions: [],
      variants: [],
      legacySlugs: [],
      idAliases: [],
      namedModelSectionIndex: 1,
      cloudAgentEffortModes: [],
      modelPickerBadges: [],
    });
    defNames.add(m);
  }
  doc.availableDefaultModels2 = defs;

  // SELECT it, don't just offer it. Adding a model to the picker leaves the
  // editor on whatever it had — `featureModelConfigs.composer.defaultModel`
  // was "default", i.e. Cursor's Auto router, which chooses ITS OWN models
  // (observed: Grok 4.6 preselected) and never reaches the zoo. Point the
  // agent/composer surfaces at our model and clear the fallbacks, or Auto
  // silently routes around us on the first hiccup.
  const primary = models[0];
  const fmc = (doc.featureModelConfigs && typeof doc.featureModelConfigs === 'object') ? doc.featureModelConfigs : {};
  for (const surface of ['composer', 'cmdK', 'backgroundComposer']) {
    fmc[surface] = { ...(fmc[surface] || {}), defaultModel: primary, fallbackModels: [], bestOfNDefaultModels: [] };
  }
  doc.featureModelConfigs = fmc;

  // Single-quote escaping for the SQL literal.
  const json = JSON.stringify(doc).replace(/'/g, "''");
  sqlite(db, `UPDATE ItemTable SET value='${json}' WHERE key='${KEY}';`);

  // VERIFY, DO NOT ASSUME. `availableAPIKeyModels` is SERVER-SYNCED: Cursor
  // rebuilds it from its own account state on launch and silently discards a
  // local write, so this function used to report "models added" for a list
  // that was empty again seconds later — and the user was told to pick a model
  // that never appeared in the dropdown. Read it back and say which parts
  // actually stuck.
  let verified = { openAIBaseUrl: null, models: [] };
  try {
    const raw2 = sqlite(db, `SELECT value FROM ItemTable WHERE key='${KEY}';`).trim();
    const doc2 = JSON.parse(raw2);
    verified = {
      openAIBaseUrl: doc2.openAIBaseUrl,
      models: (doc2.availableAPIKeyModels || []).map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean),
      selected: doc2.featureModelConfigs?.composer?.defaultModel ?? null,
    };
  } catch { /* verification is advisory */ }
  const modelsStick = models.every((m) => verified.models.includes(m));
  return { db, before, baseUrl, added, verified, modelsStick };
}

/**
 * PIN the settings with a SQLite trigger so the editor cannot revert them.
 *
 * Cursor treats the model list and selection as SERVER-authoritative: it syncs
 * them from the account on every launch and overwrites local state. Measured
 * three times — written and verified while closed, then availableAPIKeyModels
 * [] and composer.defaultModel "default" again after relaunch.
 *
 * Making the whole state.vscdb read-only would break the editor (it stores
 * window layout, history, everything there). A trigger is surgical: Cursor
 * keeps full write access, and only OUR fields are re-applied, on any write
 * that clobbers them. Removable with unpinEditorProviderConfig.
 */
export function pinEditorProviderConfig(which, { baseUrl, models }) {
  const db = storagePath(which);
  if (!fs.existsSync(db)) return null;
  const esc = (v) => String(v).replace(/'/g, "''");
  const modelJson = esc(JSON.stringify(models.map((m) => ({ name: m, defaultOn: true, supportsAgent: true }))));
  // The UI list must be pinned TOO. Pinning only availableAPIKeyModels meant
  // the editor could wipe availableDefaultModels2 — the list the Models pane
  // actually renders — and nothing put it back: measured, 413 entries in the
  // API list and 0 in the UI, i.e. the models vanished from the picker in real
  // time while the config still claimed they were there.
  const uiJson = esc(JSON.stringify(models.map((m) => ({
    name: m, defaultOn: true, supportsAgent: true, degradationStatus: 0,
    supportsThinking: true, supportsImages: true, supportsMaxMode: true,
    supportsNonMaxMode: true, serverModelName: m,
    isRecommendedForBackgroundComposer: false, supportsPlanMode: true,
    supportsSandboxing: true, isUserAdded: true, inputboxShortModelName: m,
    parameterDefinitions: [], variants: [], legacySlugs: [], idAliases: [],
    namedModelSectionIndex: 1, cloudAgentEffortModes: [], modelPickerBadges: [],
  }))));
  const primary = esc(models[0]);
  const base = esc(baseUrl);
  const sql = `
DROP TRIGGER IF EXISTS openzoo_pin;
CREATE TRIGGER openzoo_pin AFTER UPDATE ON ItemTable
WHEN NEW.key = '${KEY}'
 AND (json_extract(NEW.value,'$.openAIBaseUrl') IS NOT '${base}'
   OR json_extract(NEW.value,'$.featureModelConfigs.composer.defaultModel') IS NOT '${primary}'
   OR json_array_length(json_extract(NEW.value,'$.availableDefaultModels2')) IS NOT ${models.length})
BEGIN
  UPDATE ItemTable SET value = json_set(
      NEW.value,
      '$.openAIBaseUrl', '${base}',
      '$.useOpenAIKey', json('true'),
      '$.availableAPIKeyModels', json('${modelJson}'),
      '$.availableDefaultModels2', json('${uiJson}'),
      '$.featureModelConfigs.composer.defaultModel', '${primary}',
      '$.featureModelConfigs.cmdK.defaultModel', '${primary}'
  ) WHERE key = NEW.key;
END;`;
  try { sqlite(db, sql); } catch (e) { return { error: e.message }; }
  return { pinned: true, db };
}

/** Remove the pin — the editor goes back to managing its own settings. */
export function unpinEditorProviderConfig(which) {
  const db = storagePath(which);
  if (!fs.existsSync(db)) return null;
  try { sqlite(db, 'DROP TRIGGER IF EXISTS openzoo_pin;'); return { unpinned: true }; }
  catch (e) { return { error: e.message }; }
}
