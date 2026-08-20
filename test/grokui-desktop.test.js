import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const grokui = readFileSync(path.join(root, 'lib', 'grokui.mjs'), 'utf8');
const main = readFileSync(path.join(root, 'grokui-app', 'main.js'), 'utf8');
const preload = readFileSync(path.join(root, 'grokui-app', 'preload.js'), 'utf8');
const appPkg = require('../grokui-app/package.json');
const ozPkg = require('../package.json');

test('the Electron app does not keep a drifting grokui.mjs', () => {
  // A committed copy is how cheap/race/wallet vanished from the packaged app.
  // The live file is lib/grokui.mjs; grokui-app copies it at start/pack time.
  const copy = path.join(root, 'grokui-app', 'lib', 'grokui.mjs');
  if (existsSync(copy)) {
    assert.equal(readFileSync(copy, 'utf8'), grokui);
  }
  assert.match(main, /function grokuiScript/);
  assert.match(main, /path\.join\(__dirname, '\.\.', 'lib', 'grokui\.mjs'\)/);
  assert.match(appPkg.scripts['dist:mac'], /bundle-grokui/);
  assert.match(appPkg.scripts.start, /bundle-grokui/);
  // Packaged files are the bundled grokui-app/lib copy (bundle-grokui.js
  // writes it at start/pack). Do not require a second { from: '../lib' }
  // electron-builder extra that would ship the whole proxy tree.
  assert.equal((appPkg.build.files || []).includes('lib/**/*'), true);
});

test('cost HUD sits below the wrapping header, not on top of the dials', () => {
  assert.doesNotMatch(grokui, /#hud \{ position: fixed; top: 40px/);
  assert.doesNotMatch(grokui, /#hud \{[^}]*top:\s*40px/);
  assert.match(grokui, /function placeHud/);
  assert.match(grokui, /chatHeader\.getBoundingClientRect\(\)\.bottom/);
  assert.match(grokui, /#main \{ position: relative;/);
  const scriptStart = grokui.indexOf('<script>');
  const scriptEnd = grokui.indexOf('</script>', scriptStart);
  const script = grokui.slice(scriptStart, scriptEnd);
  assert.equal((script.match(/const chatHeader =/g) || []).length, 1);
});

test('header always ships the spend dials and wallet', () => {
  assert.match(grokui, /id="tierSel"/);
  assert.match(grokui, /id="raceSel"/);
  assert.match(grokui, /id="walletBtn"/);
  assert.match(grokui, /id="headerDials"/);
  assert.doesNotMatch(grokui, /#modeToggle \{ margin-left: auto/);
});

test('grokui does not ship an assets unlock button or decrypt route', () => {
  assert.doesNotMatch(grokui, /id="assetsBtn"/);
  assert.doesNotMatch(grokui, /id="assetsOverlay"/);
  assert.doesNotMatch(grokui, /unlockAssets/);
  assert.doesNotMatch(grokui, /\/decrypt-assets/);
  assert.doesNotMatch(grokui, /\/opt\/prooffront\.enc/);
});

test('copy/paste: Edit menu roles, Electron clipboard, selectable addresses', () => {
  assert.match(main, /role: 'copy'/);
  assert.match(main, /role: 'paste'/);
  assert.match(main, /role: 'cut'/);
  assert.match(main, /role: 'selectAll'/);
  assert.match(main, /clipboard\.writeText/);
  assert.match(preload, /copyText:/);
  assert.match(grokui, /electronAPI\.copyText/);
  assert.match(grokui, /user-select: all/);
  assert.match(grokui, /local burner on this machine/);
});

test('selecting text copies it and toasts copied', () => {
  // Select → clipboard → toast. Not ⌘C, not a tiny button, not window.alert.
  assert.match(grokui, /id="copiedToast"/);
  assert.match(grokui, /function copySettledSelection/);
  assert.match(grokui, /function showCopiedToast/);
  assert.match(grokui, /function selectedText/);
  assert.match(grokui, /scheduleCopySelection/);
  assert.match(grokui, /selectionchange/);
  assert.match(grokui, /pointerup/);
  assert.match(grokui, /el\.classList\.remove\('show'\); \}, 1200\)/);
  assert.match(grokui, /if \(!text\) return/);
  assert.match(grokui, /el\.type === 'password'/);
  assert.match(grokui, /restoreSelection/);
  assert.doesNotMatch(grokui, /window\.alert\s*\(/);
});

test('auto keeps going instead of parking on a continue note', () => {
  assert.match(grokui, /OZ_AUTO_MAX_STEPS \|\| 500/);
  assert.doesNotMatch(grokui, /OZ_AUTO_MAX_STEPS \|\| 8\b/);
  assert.doesNotMatch(grokui, /say "continue" to keep going/);
  assert.match(grokui, /const AUTO_CONTINUE/);
  assert.match(grokui, /STALLED_OFFER/);
});

test('subagents get the root ask, recent turns, and a SEND brief refresh', () => {
  assert.match(grokui, /ROOT ASK/);
  assert.match(grokui, /RECENT PARENT TURNS/);
  assert.match(grokui, /WORKING SET:/);
  assert.match(grokui, /function childKickoff/);
  assert.match(grokui, /childKickoff\(threads\.get\(originId\), target\.name, msg, \{ fresh: false \}\)/);
});

test('openzoo and grokui-app versions bump together', () => {
  assert.equal(ozPkg.version, '0.48.90');
  assert.equal(appPkg.version, '1.5.68');
});

test('HUD and wallet show prepaid credit, not only session spend', () => {
  assert.match(grokui, /id="hCredit"/);
  assert.match(grokui, /prepaid credit/);
  assert.match(grokui, /Prepaid credit/);
  assert.match(grokui, /creditUsd/);
  assert.match(grokui, /creditBalance/);
  const proxy = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  assert.match(proxy, /creditUsd, chainUsd/);
});

test('a thinking turn paints live status, not mute dots', () => {
  assert.match(grokui, /type: 'status'/);
  assert.match(grokui, /waiting on model/);
  assert.match(grokui, /peekDirectiveStatus/);
  assert.match(grokui, /liveStatus/);
  assert.match(grokui, /function liveBubbleHtml/);
  assert.match(grokui, /STALE_THINKING_MS/);
  const brain = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');
  assert.match(brain, /STREAM_IDLE/);
  assert.match(brain, /formatPayStatus/);
  assert.match(brain, /startModelWait/);
});

test('harness strips think tags, refuses MCP-as-bash, and does not join absolute dirs', () => {
  assert.match(grokui, /function stripThinkTags/);
  assert.match(grokui, /function looksLikeMcpAsBash/);
  assert.match(grokui, /function inDir/);
  assert.match(grokui, /function listDir/);
  assert.match(grokui, /MCP_AS_BASH_REFUSE/);
  assert.match(grokui, /path\.isAbsolute\(raw\) \? path\.resolve\(raw\) : path\.resolve\(root, raw\)/);
  assert.match(grokui, /get_skill, proofnetwork-\*, publish-update/);
  assert.match(grokui, /MCP: <url> \| <tool> \| \{"arg": "value"\}/);
  assert.doesNotMatch(grokui, /id="assetsBtn"/);
});

test('ensureProxy reuses a healthy :8402 and does not spawn over it', () => {
  assert.match(main, /function portOccupied/);
  assert.match(main, /if \(await portOccupied\(8402\)\) return/);
  assert.match(main, /Reuse a healthy :8402/);
});

test('the box image does not bake or decrypt encrypted ProofFront', () => {
  const dockerfile = readFileSync(path.join(root, 'box.Dockerfile'), 'utf8');
  const boot = readFileSync(path.join(root, 'box-boot.sh'), 'utf8');
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'docker-box.yml'), 'utf8');
  assert.doesNotMatch(dockerfile, /prooffront\.enc/);
  assert.doesNotMatch(dockerfile, /PROOFFRONT_URL/);
  assert.doesNotMatch(dockerfile, /COPY.*prooffront/i);
  assert.doesNotMatch(boot, /prooffront\.enc/);
  assert.doesNotMatch(boot, /OZ_PROOFFRONT_PASS/);
  assert.doesNotMatch(workflow, /PROOFFRONT_URL/);
});
