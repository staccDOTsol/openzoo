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
/**
 * PRETTY NAMES IN THE PICKER, WITHOUT LOSING VALIDATION.
 *
 * The editor validates `name` against its OWN catalog and refuses anything else
 * ("Model name is not valid" / "Max Mode Required"), so `name` MUST stay a bland
 * id it already knows. But the picker renders `inputboxShortModelName`, which it
 * does not validate — so the row can read "Opus 5" while the id stays gpt-4o.
 *
 * The zoo model that actually answers is chosen by the proxy, so a slot is a
 * (bland id -> real model -> label) triple. Override with OPENZOO_EDITOR_MAP:
 *   OPENZOO_EDITOR_MAP="gpt-4o=x-ai/grok-4.6:Grok 4.6,gpt-4.1=anthropic/claude-sonnet-5:Sonnet 5"
 */
const DEFAULT_SLOTS = {
  'gpt-4o': { served: 'anthropic/claude-opus-5', label: 'Opus 5' },
  'gpt-4.1': { served: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
  'gpt-4-turbo': { served: 'x-ai/grok-4.6', label: 'Grok 4.6' },
  'gpt-4o-mini': { served: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  'gpt-4.1-mini': { served: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro' },
  'gpt-3.5-turbo': { served: 'qwen/qwen3.8-2.4t-a95b', label: 'Qwen3.8 2.4T' },
};

export function slotFor(id) {
  // LABELS ARE OFF BY DEFAULT — they cost availability.
  //
  // Renaming the row via inputboxShortModelName is cosmetic to us but not to the
  // editor: with a label it does not recognise, it marks the model UNAVAILABLE and
  // refuses to select it. A pretty name is worth nothing if the row cannot be
  // used, so the visible text stays the bland id and OPENZOO_LABELS=1 opts back in.
  // The MAPPING is unaffected either way — gpt-4o is still served by claude-opus-5.
  if (process.env.OPENZOO_LABELS !== '1') {
    return { served: (DEFAULT_SLOTS[id] || {}).served || id, label: id };
  }
  const env = process.env.OPENZOO_EDITOR_MAP;
  if (env) {
    for (const part of env.split(',')) {
      const [lhs, rhs] = part.split('=');
      if ((lhs || '').trim() !== id || !rhs) continue;
      const [served, ...lbl] = rhs.split(':');
      return { served: served.trim(), label: (lbl.join(':') || served).trim() };
    }
  }
  return DEFAULT_SLOTS[id] || { served: id, label: id };
}

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
  // MEMBERSHIP FORGERY IS OPT-IN. Setting membershipType here spoofs Cursor's
  // paid-tier gate on an unpaid account — only do it when the operator explicitly
  // asks with OPENZOO_MEMBERSHIP. Default writes leave the real membership alone.
  if (process.env.OPENZOO_MEMBERSHIP) {
    doc.membershipType = process.env.OPENZOO_MEMBERSHIP;
    doc.subscriptionStatus = 'active';
  }
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
      inputboxShortModelName: slotFor(m).label,
      isRecommendedForBackgroundComposer: false,
      supportsPlanMode: true,
      supportsSandboxing: true,
      isUserAdded: true,
      parameterDefinitions: [],
      variants: [],
      legacySlugs: [],
      idAliases: [],
      // SECTION 0, not 1. The named-models view groups rows by this index and
      // renders section 0; every row we wrote pointed at section 1, which put them
      // in a group the dropdown does not draw — visible in Settings (which ignores
      // the index) but "unavailable" in the composer picker. That split — right in
      // Settings, missing from the dropdown — is the tell.
      // BOTH VIEWS. Read out of Cursor's own bundle:
      //   routed view (the dropdown that opens on "Auto"):
      //     _d_(t) => t.visibleInRoutedModelView === true && t.defaultOn !== false
      //   named view (the Settings list):
      //     filter(v => v.namedModelSectionIndex !== undefined)
      // We only ever set the second, so our models were present in Settings and
      // ABSENT from the composer dropdown — exactly the split that was reported.
      visibleInRoutedModelView: true,
      namedModelSectionIndex: 0,
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
  const mem = process.env.OPENZOO_MEMBERSHIP || null;
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
    supportsSandboxing: true, isUserAdded: true, inputboxShortModelName: slotFor(m).label,
    parameterDefinitions: [], variants: [], legacySlugs: [], idAliases: [],
    visibleInRoutedModelView: true, namedModelSectionIndex: 0, cloudAgentEffortModes: [], modelPickerBadges: [],
  }))));
  const primary = esc(models[0]);
  const base = esc(baseUrl);
  const sql = `
DROP TRIGGER IF EXISTS openzoo_pin;
CREATE TRIGGER openzoo_pin AFTER UPDATE ON ItemTable
WHEN NEW.key = '${KEY}'
 AND (json_extract(NEW.value,'$.openAIBaseUrl') IS NOT '${base}'
   OR json_extract(NEW.value,'$.featureModelConfigs.composer.defaultModel') IS NOT '${primary}'
   OR json_array_length(json_extract(NEW.value,'$.availableDefaultModels2')) IS NOT ${models.length}${mem ? `
   OR json_extract(NEW.value,'$.membershipType') IS NOT '${mem}'` : ''})
BEGIN
  UPDATE ItemTable SET value = json_set(
      NEW.value,
      '$.openAIBaseUrl', '${base}',
      '$.useOpenAIKey', json('true'),
      '$.availableAPIKeyModels', json('${modelJson}'),
      '$.availableDefaultModels2', json('${uiJson}'),
      '$.featureModelConfigs.composer.defaultModel', '${primary}',
      '$.featureModelConfigs.cmdK.defaultModel', '${primary}'${mem ? `,
      '$.membershipType', '${mem}',
      '$.subscriptionStatus', 'active'` : ''}
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

/**
 * Force the CACHED membership the editor stores in its own auth table to an
 * entitled value. MEASURED: the working (ultra) machine held
 * `cursorAuth/stripeMembershipType = "ultra"` right here in ItemTable, the free
 * machine held "free" — and the model-selection gate reads this cached value,
 * NOT the api2 responses (which we already answer entitled, to no effect). The
 * api2 impersonation's job is then to stop the editor RE-SYNCING this back to
 * free on the next focus. Best-effort; returns what it set.
 */
export function forceMembership(which, type = 'pro') {
  const db = storagePath(which);
  if (!db || !fs.existsSync(db)) return { error: 'no editor db' };
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); } catch { return { error: 'sqlite3 not available' }; }
  const q = (k) => `'${String(k).replace(/'/g, "''")}'`;
  const set = (key, val) => {
    // These auth values are stored as raw JSON strings (quoted), e.g. "ultra".
    const json = JSON.stringify(String(val));
    sqlite(db, `INSERT INTO ItemTable(key,value) VALUES(${q(key)},${q(json)}) `
      + `ON CONFLICT(key) DO UPDATE SET value=${q(json)};`);
  };
  try {
    set('cursorAuth/stripeMembershipType', type);
    set('cursorAuth/stripeSubscriptionStatus', 'active');
    const got = sqlite(db, `SELECT value FROM ItemTable WHERE key='cursorAuth/stripeMembershipType';`).trim();
    return { set: type, verified: got };
  } catch (e) { return { error: e.message }; }
}
