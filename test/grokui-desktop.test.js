import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const grokui = readFileSync(path.join(root, 'lib', 'grokui.mjs'), 'utf8');

function inlineAppScript(src) {
  const close = src.lastIndexOf('</script>');
  let open = src.lastIndexOf('<script>', close);
  while (open >= 0 && /^\s*<script\s+src=/i.test(src.slice(open, open + 48))) {
    open = src.lastIndexOf('<script>', open - 1);
  }
  return { open, close, script: open >= 0 && close > open ? src.slice(open, close) : '' };
}
const main = readFileSync(path.join(root, 'grokui-app', 'main.js'), 'utf8');
const preload = readFileSync(path.join(root, 'grokui-app', 'preload.js'), 'utf8');
const appPkg = require('../grokui-app/package.json');
const ozPkg = require('../package.json');

test('grokui app version is 1.6.11 so the next tag sorts above 1.5.99', () => {
  assert.equal(appPkg.version, '1.6.11');
  const harness = readFileSync(path.join(root, 'lib', 'harness-install.js'), 'utf8');
  assert.match(harness, /OPENZOO_CLAUDE_SPEC/);
  assert.match(harness, /ELECTRON_RUN_AS_NODE/);
  assert.match(harness, /localBinDir/);
  assert.match(harness, /copyPackedHarness/);
  assert.doesNotMatch(harness, /claude\.ai\/install/);
  assert.match(grokui, /ensureHarness/);
  assert.match(grokui, /shouldSkipHarnessAutostart/);
  const claude = readFileSync(path.join(root, 'lib', 'claudecode.js'), 'utf8');
  assert.doesNotMatch(claude, /npx -y openzoo-claude/);
  assert.doesNotMatch(claude, /PTY_WINDOWS/);
  assert.doesNotMatch(claude, /install node-pty/);
  assert.doesNotMatch(claude, /--print cannot grow/);
  assert.equal(appPkg.build.npmRebuild, true);
  assert.equal(appPkg.build.includeSubNodeModules, true);
  assert.ok(appPkg.dependencies['node-pty']);
  assert.ok(appPkg.dependencies['openzoo-claude']);
});

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
  // bundle-grokui.js copies the ENTIRE repo lib/ into grokui-app/lib;
  // electron-builder files: lib/**/* plus afterPack copyRepoLib put that
  // tree at Contents/Resources/app/lib (or resources/app/lib). A filename
  // whitelist omitted info.js and :4173 never bound (1.5.86).
  assert.equal((appPkg.build.files || []).includes('lib/**/*'), true);
  assert.equal((appPkg.build.files || []).includes('sidecar-heal.js'), true);
  assert.equal((appPkg.build.files || []).includes('sidecar-version.js'), true);
});

test('bundle-grokui copies the entire repo lib, not a filename whitelist', () => {
  const bundle = readFileSync(path.join(root, 'grokui-app', 'scripts', 'bundle-grokui.js'), 'utf8');
  assert.match(bundle, /cpSync\(srcDir, destDir/);
  assert.doesNotMatch(bundle, /for \(const f of \[/);
  assert.doesNotMatch(bundle, /'grokui\.mjs', 'podagent\.mjs'/);
  const r = spawnSync(process.execPath, [path.join(root, 'grokui-app', 'scripts', 'bundle-grokui.js')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const dest = path.join(root, 'grokui-app', 'lib');
  for (const f of ['grokui.mjs', 'grokui-subagents.js', 'info.js', 'hrr.js', 'spill.js', 'subscription.js', 'livestatus.js', 'podagent.mjs', 'worktree.mjs', 'package.json']) {
    assert.equal(existsSync(path.join(dest, f)), true, f);
  }
  const destPkg = JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8'));
  assert.equal(destPkg.type, 'module');
  assert.equal(appPkg.type, undefined, 'grokui-app/package.json must stay CJS (main.js is require())');
  const walk = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-esm-relatives.mjs'), path.join(dest, 'grokui.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(walk.status, 0, walk.stderr || walk.stdout);
  const esm = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-grokui-esm.mjs'), dest], {
    encoding: 'utf8',
  });
  assert.equal(esm.status, 0, esm.stderr || esm.stdout);
});

test('the 1.5.86 grokui-app lib whitelist is missing grokui.mjs relatives', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-app-lib-'));
  try {
    for (const f of ['grokui.mjs', 'podagent.mjs', 'livestatus.js', 'worktree.mjs', 'racesettle.js']) {
      cpSync(path.join(root, 'lib', f), path.join(dir, f));
    }
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-esm-relatives.mjs'), path.join(dir, 'grokui.mjs')], {
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /info\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cost HUD sits below the wrapping header, not on top of the dials', () => {
  assert.doesNotMatch(grokui, /#hud \{ position: fixed; top: 40px/);
  assert.doesNotMatch(grokui, /#hud \{[^}]*top:\s*40px/);
  assert.match(grokui, /function placeHud/);
  assert.match(grokui, /chatHeader\.getBoundingClientRect\(\)\.bottom/);
  assert.match(grokui, /#main \{ position: relative;/);
  const script = inlineAppScript(grokui).script;
  assert.equal((script.match(/const chatHeader =/g) || []).length, 1);
});

test('header always ships the spend dials and wallet', () => {
  assert.match(grokui, /id="tierSel"/);
  assert.match(grokui, /value="grok4.6"/);
  assert.match(grokui, />grok 4.6</);
  assert.match(grokui, /id="raceSel"/);
  assert.match(grokui, /id="walletBtn"/);
  assert.match(grokui, /id="headerDials"/);
  assert.match(grokui, /id="paneActions"/);
  assert.doesNotMatch(grokui, /#modeToggle \{ margin-left: auto/);
});

test('sitrep is a plus-menu button that opens a wallet-style drawer, not a chat dump', () => {
  const attach = grokui.indexOf('id="attachBtn"');
  const sitrep = grokui.indexOf('id="sitrepBtn"');
  assert.ok(attach >= 0 && sitrep > attach, 'Sitrep sits next to Attach files');
  assert.match(grokui, /id="sitrepOverlay"/);
  assert.match(grokui, /data-component="sitrep-drawer"/);
  assert.match(grokui, /id="sitrepBox"/);
  assert.match(grokui, /function openSitrep/);
  assert.doesNotMatch(grokui, /function runSitrep/);
  assert.match(grokui, /name: '\/sitrep'/);
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.doesNotMatch(appHtml, /\/\^\\\/sitrep\\b/);
  assert.match(appHtml, /s === '\/sitrep'/);
  assert.match(appHtml, /s\.startsWith\('\/sitrep '/);
  assert.match(grokui, /Drawer-only\. Never dump sitrep into the transcript/);
  assert.match(grokui, /if \(c\.name === '\/sitrep'\)/);
  assert.match(grokui, /sitrepRow\('race'/);
  assert.match(grokui, /sitrepRow\('paid calls'/);
  assert.match(grokui, /sitrepRow\('prepaid', \(Number\(you\.creditUsd\) > 0\) \? 'yes' : 'no'\)/);
  assert.match(grokui, /sitrepRow\('proxy', proxyDown \? 'unreachable' : 'ok'/);
  assert.doesNotMatch(grokui, /formatSitrep/);
  assert.doesNotMatch(grokui, /task: '\/sitrep'/);
  assert.doesNotMatch(grokui, /sitrepRow\('subscription'/);
  assert.doesNotMatch(grokui, /sitrep.*npmrc/i);
  assert.match(grokui, /formatSavingLabel\(you\)/);
  assert.match(grokui, /' spilled'/);
  assert.match(grokui, /' session'/);
});

test('HUD sitrep and /cost paint Nx spilled vs Nx session, never unlabeled Nx', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(appHtml, /formatSavingLabel/);
  assert.match(appHtml, /savedEl\.textContent = sav\.text/);
  assert.doesNotMatch(appHtml, /savedEl\.textContent = \([^)]+\) \+ 'x'/);
  assert.match(grokui, /function formatSavingLabel/);
  assert.match(grokui, /num \+ \(spilled \? ' spilled' : ' session'\)/);
  assert.match(grokui, /multiple        \$\{sav\.text\}/);
  assert.match(grokui, /HUD is spilled-call x when any call bound/);
});

test('sitrep and HUD paint proxy unreachable, not a fake $0 session, until health returns', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(grokui, /proxyReachable: false/);
  assert.match(grokui, /r\.status === 402/);
  assert.match(grokui, /http:\/\/127\.0\.0\.1:8402\/v1\/models/);
  assert.match(appHtml, /you\.proxyReachable === false/);
  assert.match(appHtml, /hYouSpent'\)\.textContent = 'proxy unreachable'/);
  assert.match(appHtml, /paidEl\.textContent = 'proxy unreachable'/);
  assert.match(appHtml, /sitrepRow\('paid', proxyDown \? 'proxy unreachable'/);
  assert.match(appHtml, /setHudTick\(proxyDown \? 2000 : 30000\)/);
  assert.match(grokui, /Sitrep — mode \$\{mode\} · \$\{tier\} · proxy unreachable\./);
  assert.doesNotMatch(appHtml, /if \(isEmptyWalletPayment\(text\)\) openWallet/);
});

test('always-on dock HUD is a sidebar footer, not over chat or #bar', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(grokui, /id="dockHud"/);
  assert.match(grokui, /data-component="dock-hud"/);
  assert.match(grokui, /id="dockSpill"/);
  assert.match(grokui, /id="dockSession"/);
  assert.match(grokui, /id="dockPaid"/);
  assert.match(grokui, /id="dockBind"/);
  assert.match(grokui, /id="dockCalls"/);
  assert.doesNotMatch(grokui, /#dockHud \{ position: absolute; left: 14px; bottom: 72px/);
  assert.match(grokui, /#dockHud \{ flex: 0 0 auto;/);
  assert.match(grokui, /#dockHud \{[\s\S]*?pointer-events: none/);
  assert.match(grokui, /#hud \{[^}]*z-index: 300/);
  assert.match(appHtml, /function paintDock/);
  assert.doesNotMatch(appHtml, /function placeDockHud/);
  assert.match(appHtml, /function ensureHudTick/);
  assert.match(appHtml, /paintDock\(you\)/);
  assert.match(appHtml, /ensureHudTick\(\)/);
  assert.match(appHtml, /spillEl\.className = spillOn \? 'dv hlime' : 'dv'/);
  assert.match(appHtml, /sessEl\.className = 'dv'/);
  assert.match(appHtml, /bindEl\.textContent = bound \? 'yes' : 'no'/);
  assert.doesNotMatch(appHtml, /else if \(hudTimer\) \{\s*clearInterval\(hudTimer\)/);
  const hudBtn = appHtml.indexOf("hudBtn.addEventListener('click'");
  const clearTick = appHtml.indexOf('clearInterval(hudTimer)', hudBtn);
  assert.equal(clearTick, -1, 'closing ◎ must not stop the dock refresh');
  const sideOpen = grokui.indexOf('<div id="sidebar">');
  const sideClose = grokui.indexOf('<div id="composeOverlay">');
  const mainOpen = grokui.indexOf('<div id="main">');
  const dockHtml = grokui.indexOf('id="dockHud"');
  const threadsHtml = grokui.indexOf('id="threads"');
  assert.ok(sideOpen > 0 && dockHtml > sideOpen && dockHtml < sideClose, 'dock lives in #sidebar');
  assert.ok(threadsHtml > sideOpen && dockHtml > threadsHtml, 'dock is the sidebar footer after the bot list');
  assert.ok(mainOpen > sideClose, 'sidebar ends before #main');
  assert.ok(dockHtml < mainOpen, 'dock is not a child of the chat column');
});

test('header dials Pay and ◎ echo a short system line via /drive', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(appHtml, /function echoSlash/);
  assert.match(appHtml, /echoSlash\('\/' \+ cmd \+ ' ' \+ value\)/);
  assert.match(appHtml, /echoSlash\('\/mode ' \+ mode\)/);
  assert.match(appHtml, /echoSlash\('\/pay'\)/);
  assert.match(appHtml, /echoSlash\('\/hud'\)/);
  assert.match(grokui, /if \(cmd === 'pay'\)/);
  assert.match(grokui, /if \(cmd === 'hud'\)/);
  assert.match(grokui, /Pay — card checkout or the local wallet\/x402 burner/);
  assert.match(grokui, /Sitrep — mode \$\{mode\}/);
  assert.doesNotMatch(appHtml, /task: '\/sitrep'/);
});

test('served APP_HTML <script> is valid JS (node --check)', () => {
  const src = grokui.replace(/\r\n/g, '\n');
  const start = src.indexOf('const APP_HTML = `');
  const end = src.indexOf('`;\n\nconst server = http.createServer', start);
  assert.ok(start >= 0 && end > start, 'APP_HTML template bounds');
  const literal = src.slice(start + 'const APP_HTML = '.length, end + 1);
  // APP_HTML interpolates SUBSCRIPTIONS_PAGE into an href. Stub it so we
  // can evaluate the template and --check the script the browser actually gets.
  const html = Function('SUBSCRIPTIONS_PAGE', 'return ' + literal)('https://example.test/subscriptions');
  const { open, close, script: tagged } = inlineAppScript(html);
  assert.ok(open >= 0 && close > open, 'served HTML has a script');
  const script = tagged.startsWith('<script>') ? tagged.slice('<script>'.length) : tagged;
  assert.doesNotMatch(script, /\/\^\/sitrep/);
  assert.match(script, /s === '\/sitrep'/);
  assert.match(script, /includes\('wallet is empty'\)/);
  // Eaten \b becomes a literal backspace inside a regex literal (wallet-empty).
  // Do not scan comments — they mention /^/api// as the failure mode.
  const regexLits = script.match(/\/(?:\\.|[^/\n])+\/[gimsuy]*/g) || [];
  for (const r of regexLits) {
    assert.doesNotMatch(r, /\x08/, 'regex has eaten \\b: ' + r);
    assert.doesNotMatch(r, /\/\^\/[A-Za-z]/, 'regex has eaten \\/: ' + r);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-apphtml-'));
  try {
    const file = path.join(dir, 'apphtml.js');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assert-app-html-script accepts a CRLF copy of grokui.mjs (1.5.88 Windows)', () => {
  // actions/checkout + autocrlf on Windows turns lib/grokui.mjs into CRLF.
  // The 1.5.88 assert looked for `;\n\nconst server` (LF-only) and printed
  // "APP_HTML template bounds missing" in 21s. Do not set type:module on
  // grokui-app/package.json — that is CJS because main.js is require().
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-apphtml-crlf-'));
  try {
    const crlf = grokui.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const copy = path.join(dir, 'grokui.mjs');
    writeFileSync(copy, crlf);
    assert.equal(crlf.indexOf('`;\n\nconst server = http.createServer'), -1);
    assert.ok(crlf.indexOf('`;\r\n\r\nconst server = http.createServer') >= 0);
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-app-html-script.mjs'), copy], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /ok: served APP_HTML <script> parses/);
    const assertSrc = readFileSync(path.join(root, 'scripts', 'assert-app-html-script.mjs'), 'utf8');
    assert.match(assertSrc, /replace\(\/\\r\\n\/g/);
    assert.equal(appPkg.type, undefined);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'lib', 'package.json'), 'utf8')).type, 'module');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('race picker paints the savings cut on every choice, including 1-model', () => {
  // Cut = (1 - 1/Y). X does not change it — they pay every launched racer.
  assert.match(grokui, />1 model  0%</);
  assert.match(grokui, />race 2  −50%</);
  assert.match(grokui, />race 3  −67%</);
  assert.match(grokui, />race 4  −75%</);
  assert.match(grokui, />best 2 of 3  −67%</);
  assert.match(grokui, />best 2 of 4  −75%</);
  assert.match(grokui, />best 3 of 4  −75%</);
  assert.match(grokui, />best 4 of 4  −75%</);
  assert.doesNotMatch(grokui, /<option value="0"[^>]*>1 model</);
  assert.doesNotMatch(grokui, /<option value="2 4">best 2 of 4</);
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
  assert.match(main, /clipboard\.readText/);
  assert.match(preload, /copyText:/);
  assert.match(preload, /readText:/);
  assert.match(grokui, /electronAPI\.copyText/);
  assert.match(grokui, /electronAPI\.readText/);
  assert.match(grokui, /user-select: all/);
  assert.match(grokui, /local burner on this machine/);
});

test('Cmd/Ctrl+F finds in the current #log, not the sidebar thread search', () => {
  // Sidebar #search + Cmd/Ctrl+K stays GET /search. Find is a different bar.
  assert.match(grokui, /id="findBar"/);
  assert.match(grokui, /id="findInp"/);
  assert.match(grokui, /id="findCount"/);
  assert.match(grokui, /data-component="find-in-thread"/);
  assert.match(grokui, /function openFindBar/);
  assert.match(grokui, /function closeFindBar/);
  assert.match(grokui, /function applyFind/);
  assert.match(grokui, /function findStep/);
  assert.match(grokui, /querySelectorAll\('\.bubble'\)/);
  assert.match(grokui, /mark\.findhit/);
  assert.match(grokui, /k === 'f'/);
  assert.match(grokui, /k === 'g' && findBarOpen\(\)/);
  assert.match(grokui, /k === 'k'/);
  assert.match(grokui, /getElementById\('search'\)/);
  assert.match(grokui, /' \/ '/);
  assert.doesNotMatch(grokui, /findInPage/);
  // Cmd+K must still be thread search — do not steal it for in-log find.
  const script = inlineAppScript(grokui).script;
  assert.match(script, /withMod && k === 'k'/);
  assert.match(script, /withMod && k === 'f'/);
  const kHandler = script.slice(script.indexOf("k === 'k'"), script.indexOf("k === 'k'") + 220);
  assert.match(kHandler, /getElementById\('search'\)/);
  assert.doesNotMatch(kHandler, /openFindBar/);
  const fHandler = script.slice(script.indexOf("k === 'f'"), script.indexOf("k === 'f'") + 160);
  assert.match(fHandler, /openFindBar/);
  assert.doesNotMatch(fHandler, /getElementById\('search'\)/);
  // Edit menu Find (Electron intercepts Cmd+F once the item exists).
  assert.match(main, /label: 'Find'/);
  assert.match(main, /CmdOrCtrl\+F/);
  assert.match(main, /find-in-thread/);
  assert.match(preload, /onFindInThread/);
  assert.match(grokui, /electronAPI\.onFindInThread/);
});

test('find-in-thread match split is case-insensitive and counts i / n', () => {
  // Same walk as highlightTextNode inside APP_HTML — no regex, so the
  // template literal cannot eat \\b. A query that hits twice is 1 / 2.
  function splitHits(text, query) {
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    const parts = [];
    let idx = hay.indexOf(needle, from);
    while (idx !== -1) {
      if (idx > from) parts.push({ t: text.slice(from, idx), hit: false });
      parts.push({ t: text.slice(idx, idx + needle.length), hit: true });
      from = idx + needle.length;
      idx = hay.indexOf(needle, from);
    }
    if (!parts.length) return [];
    if (from < text.length) parts.push({ t: text.slice(from), hit: false });
    return parts;
  }
  const parts = splitHits('Foo bar foo BAZ', 'foo');
  const hits = parts.filter((p) => p.hit);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].t, 'Foo');
  assert.equal(hits[1].t, 'foo');
  assert.equal((0 + 1) + ' / ' + hits.length, '1 / 2');
  assert.equal(splitHits('nothing', 'foo').length, 0);
  assert.match(grokui, /hay\.indexOf\(needle, from\)/);
  assert.match(grokui, /querySelectorAll\('\.bubble'\)/);
  assert.doesNotMatch(grokui, /querySelectorAll\('\.runcard'\)/);
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

test('Desktop pane actions bar: Copy / Paste / Dir / Stop in #chatHeader', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(appHtml, /id="paneActions"/);
  assert.match(appHtml, /data-component="pane-actions"/);
  assert.match(appHtml, /id="actCopy"/);
  assert.match(appHtml, /id="actPaste"/);
  assert.match(appHtml, /id="dirPickBtn"/);
  assert.match(appHtml, /id="actStop"/);
  assert.match(appHtml, /function copyFromBar/);
  assert.match(appHtml, /function pasteFromBar/);
  assert.match(appHtml, /function insertIntoMessage/);
  assert.match(appHtml, /function readClipboardText/);
  assert.match(appHtml, /function stopAgent/);
  assert.match(appHtml, /function agentTermSelection/);
  assert.match(appHtml, /agentTerm\.getSelection/);
  assert.match(appHtml, /insertIntoMessage\(text\)/);
  assert.match(appHtml, /electronAPI\.readText/);
  assert.match(appHtml, /electronAPI\.pickDirectory/);
  assert.match(appHtml, /echoSlash\('\/dir ' \+ dir\)/);
  assert.match(appHtml, /body: String\.fromCharCode\(27\)/);
  assert.match(appHtml, /body: task \+ String\.fromCharCode\(13\)/);
  assert.match(appHtml, /body\.agent-mode #actStop/);
  assert.match(appHtml, /#paneActions \{ display: flex;/);
  // One Dir control — #88 folder picker lives in this bar, not next to cwd.
  assert.equal((appHtml.match(/id="dirPickBtn"/g) || []).length, 1);
  assert.doesNotMatch(appHtml, /"\\r"/);
  assert.doesNotMatch(appHtml, /'\\r'/);
  assert.doesNotMatch(appHtml, /\\x1b/);
  assert.doesNotMatch(appHtml, /\\u001b/);
  assert.doesNotMatch(appHtml, /String\.fromCharCode\(27\).*String\.fromCharCode\(13\)/);
  // Paste prefers Message; do not POST clipboard to the PTY from the button.
  const pasteFn = appHtml.slice(appHtml.indexOf('async function pasteFromBar'), appHtml.indexOf('function stopAgent'));
  assert.match(pasteFn, /insertIntoMessage\(text\)/);
  assert.doesNotMatch(pasteFn, /\/pty/);
  assert.doesNotMatch(pasteFn, /fromCharCode\(13\)/);
  assert.doesNotMatch(pasteFn, /fromCharCode\(27\)/);
});

test('Agent mode is Claude Code via OpenZoo, not the RUN: text harness', () => {
  assert.match(grokui, /from '\.\/claudecode\.js'/);
  assert.match(grokui, /async function runAutoClaudeTurn/);
  assert.match(grokui, /function isAgentMode/);
  assert.match(grokui, /function normalizeRunMode/);
  assert.match(fnBody(grokui, 'runTurn'), /isAgentMode\(t\)/);
  assert.match(grokui, /usedClaude = true/);
  assert.match(grokui, /runClaudeCode\(/);
  assert.match(grokui, /function runClaudeCodeBounded/);
  assert.match(fnBody(grokui, 'runAutoClaudeTurn'), /runClaudeCodeBounded\(/);
  assert.match(fnBody(grokui, 'runClaudeCodeBounded'), /new AbortController/);
  assert.match(fnBody(grokui, 'runClaudeCodeBounded'), /do not abort turnAbort|ptyAbort/);
  assert.doesNotMatch(fnBody(grokui, 'runClaudeCodeBounded'), /\(no response\)/);
  assert.doesNotMatch(grokui, /OZ_AUTO_CLAUDE_PTY_MS \|\| 3000/);
  const claudeSrc = readFileSync(path.join(root, 'lib', 'claudecode.js'), 'utf8');
  assert.match(claudeSrc, /export function waitIdle/);
  assert.match(claudeSrc, /WAIT_IDLE_HARD_MS = 90_000/);
  assert.match(claudeSrc, /spinner\/think|think \/ spinner/);
  assert.match(claudeSrc, /Idle prompt \+ visible text is NOT/);
  assert.match(fnBody(claudeSrc, 'waitIdle'), /tryDone/);
  assert.doesNotMatch(fnBody(claudeSrc, 'waitIdle'), /sessionVisibleText\(sess\) && \(sessionIdle/);
  assert.match(claudeSrc, /eventKeepsAlive/);
  assert.match(claudeSrc, /stayLive/);
  assert.match(claudeSrc, /hasLiveClaudeSession/);
  assert.match(claudeSrc, /TOOL_RUNNING_LINE|isToolRunningLine/);
  assert.match(fnBody(grokui, 'runTurn'), /Promise\.race\(/);
  assert.match(fnBody(grokui, 'runTurn'), /ENSURE_HARNESS_SEND_MS/);
  assert.match(grokui, /ENSURE_HARNESS_SEND_MS = 2500/);
  assert.match(grokui, /Claude Code via OpenZoo/);
  assert.doesNotMatch(grokui, /say "continue" to keep going/);
  assert.match(grokui, /const AUTO_CONTINUE/);
  assert.match(grokui, /kickTurn\(threadId, userText, onEvent\)/);
  const autoFn = fnBody(grokui, 'runAutoClaudeTurn');
  assert.doesNotMatch(autoFn, /parseRun\(/);
  assert.doesNotMatch(autoFn, /tryDirective\(/);
  assert.doesNotMatch(autoFn, /enqueueAutoHop\(/);
  assert.doesNotMatch(autoFn, /AUTO_DIRECTIVE/);
  assert.doesNotMatch(autoFn, /fetch\([^)]*chat\/completions/);
  assert.match(autoFn, /claudeModelArg\(t\.model\)/);
  assert.doesNotMatch(autoFn, /model: t\.model \|\| undefined/);
  assert.match(grokui, /claudeModelArg/);
  assert.match(autoFn, /sanitizeClaudeCanvas/);
  assert.match(autoFn, /keepFold/);
  assert.match(grokui, /sanitizeClaudeCanvas/);
  const launch = readFileSync(path.join(root, 'lib', 'launch.js'), 'utf8');
  assert.match(launch, /export function claudeZooEnv/);
  assert.match(launch, /delete env\.ANTHROPIC_API_KEY/);
  assert.match(launch, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(launch, /npx -y openzoo-claude|'-y', OPENZOO_CLAUDE_PACKAGE/);
  assert.match(launch, /export function resolveOpenzooClaude/);
  assert.doesNotMatch(launch, /claude\.ai\/install\.sh/);
  assert.doesNotMatch(launch, /install Claude Code/);
  const claude = readFileSync(path.join(root, 'lib', 'claudecode.js'), 'utf8');
  assert.doesNotMatch(claude, /export function claudePrintArgs/);
  assert.doesNotMatch(claude, /'--print'/);
  assert.doesNotMatch(claude, /'--output-format'/);
  assert.doesNotMatch(claude, /'stream-json'/);
  assert.match(claude, /export function claudeInteractiveArgs/);
  assert.match(claude, /export function claudeModelArg/);
  assert.match(claude, /isAutoModel/);
  assert.match(claude, /spawnClaudePty/);
  assert.match(claude, /bypassPermissions/);
  assert.match(claude, /Do not curl localhost:8402\/v1\/chat\/completions/);
  assert.doesNotMatch(claude, /spawn\([^)]*curl/);
  assert.match(claude, /const pin = claudeModelArg\(model\)/);
  assert.doesNotMatch(claude, /if \(model\) args\.push\('--model', String\(model\)\)/);
  assert.match(grokui, /function isGrokuiOwnedSlash/);
  assert.match(grokui, /id="modeChat"/);
  assert.match(grokui, /id="modeAgent"/);
  assert.match(grokui, />Agent</);
  assert.doesNotMatch(grokui, /id="modeAgent"[^>]*>\s*auto/i);
  assert.match(grokui, /\/mode\\s\+\(chat\|agent\|auto\|ask\)/);
  assert.match(grokui, /CLAUDE_SLASH_IN_AUTO/);
  assert.match(grokui, /\['agents', 'tasks', 'context', 'model', 'goal'\]/);
  assert.match(claude, /GROKUI_RESERVED_SLASH = Object\.freeze\(\['mode', 'tier', 'help', 'dir'\]\)/);
  assert.doesNotMatch(claude, /GROKUI_RESERVED_SLASH = Object\.freeze\(\[[^\]]*goal/);
  assert.match(grokui, /closeClaudeSession/);
  assert.match(autoFn, /sessionKey: t\.id/);
  assert.match(autoFn, /PTY_PENDING|isAutoPtyPending/);
  assert.match(autoFn, /stayLive: true/);
  assert.match(autoFn, /return finalText;/);
  assert.match(autoFn, /result\.missing|result\.ptyPending/);
  assert.doesNotMatch(autoFn, /\(no response\)/);
  assert.match(autoFn, /isClaudeSubagentTool/);
  assert.match(autoFn, /adoptClaudeSubagent/);
  assert.match(autoFn, /claudeSubagentHopText/);
  assert.match(grokui, /function adoptClaudeSubagent/);
  const subagents = readFileSync(path.join(root, 'lib', 'grokui-subagents.js'), 'utf8');
  assert.match(subagents, /Messaged \$\{unique\.length\} Bots/);
  assert.doesNotMatch(autoFn, /noteTool\(folded\.name/);
  assert.match(grokui, /sidecar starting…/);
  assert.match(grokui, /function waitForSidecarSession/);
  {
    const run = fnBody(grokui, 'runTurn');
    const waitAt = run.indexOf('waitForSidecarSession');
    const autoAt = run.indexOf('if (isAgentMode(t))');
    assert.ok(waitAt >= 0, 'runTurn waits for :8402');
    assert.ok(autoAt < 0 || waitAt < autoAt, 'Chat as well as Agent waits for :8402');
  }
  assert.match(grokui, /function autoClaudeTurnProducedVisible/);
  assert.match(fnBody(grokui, 'runTurn'), /usedClaude = false/);
  assert.match(fnBody(grokui, 'runTurn'), /isAutoPtyPending/);
  assert.doesNotMatch(fnBody(grokui, 'runTurn'), /if \(threadHasVisibleBotReply\(t\)\)/);
});

test('install docs ship Mac nvm+openzoo claude and Windows nvm-windows, not official Claude', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const notes = readFileSync(path.join(root, '.github', 'grokui-release-notes.md'), 'utf8');
  assert.match(notes, /Silicon Mac/);
  assert.match(notes, /arm64\.dmg/);
  assert.match(notes, /Windows/);
  assert.match(notes, /\bexe\b/);
  assert.match(notes, /Linux/);
  assert.match(notes, /AppImage/);
  assert.match(notes, /openzoo-claude/);
  assert.match(notes, /^Silicon Mac users download the arm64\.dmg, Windows the exe, Linux the AppImage\./m);
  assert.match(notes, /1\.6\.5:.*first boot already has/i);
  assert.match(notes, /1\.6\.4:.*waitIdle.*send completes on Claude Code/s);
  assert.match(notes, /Hung PTY Auto falls through to completions in 3s/);
  assert.match(notes, /do not ship a PTY that eats the send/);
  assert.match(notes, /first (?:launch|run)|~\/\.local\/bin/i);
  assert.match(notes, /first (?:launch|run)|~\/\.local\/bin/i);
  assert.doesNotMatch(notes, /npx -y openzoo-claude/);
  for (const src of [readme, notes]) {
    assert.doesNotMatch(src, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.doesNotMatch(src, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
    assert.doesNotMatch(src, /downloads\.claude\.ai\/install\.cmd/);
    assert.match(src, /openzoo-claude/);
  }
  assert.match(readme, /raw\.githubusercontent\.com\/nvm-sh\/nvm\/v0\.40\.7\/install\.sh/);
  assert.match(readme, /\. "\$HOME\/\.nvm\/nvm\.sh"/);
  assert.match(readme, /nvm install 24/);
  assert.match(readme, /npm i -g openzoo/);
  assert.match(readme, /openzoo claude/);
  assert.match(readme, /coreybutler\/nvm-windows/);
  assert.match(readme, /nvm-setup\.exe/);
  assert.match(readme, /Then nvm-windows:/);
  assert.match(readme, /nvm use 24/);
  assert.match(readme, /Do not use the unix nvm curl on Windows/);
  assert.match(readme, /Do not source `~\/\.zshrc`/);
  assert.match(readme, /(?:Do not install official Claude Code|Do not curl)/);
  const win = readme.slice(readme.indexOf('Windows — nvm-windows'));
  assert.doesNotMatch(win, /source ~\/\.zshrc/);
  assert.doesNotMatch(win, /claude\.ai\/install\.sh/);
  assert.doesNotMatch(win, /nvm-sh\/nvm/);
});

test('subagents get the root ask, recent turns, and a SEND brief refresh', () => {
  assert.match(grokui, /ROOT ASK/);
  assert.match(grokui, /RECENT PARENT TURNS/);
  assert.match(grokui, /WORKING SET:/);
  assert.match(grokui, /function childKickoff/);
  assert.match(grokui, /childKickoff\(threads\.get\(originId\), target\.name, msg, \{ fresh: false \}\)/);
  // Repeat SPAWN is a wake, not another CONTEXT REFRESH.
  assert.match(grokui, /wakeOnPing\(existing\)/);
  assert.doesNotMatch(grokui, /runTurn\(existing\.id, childKickoff/);
  // Kids must not inherit p.dir (testingcluade). Isolation is prepareChildDir.
  assert.doesNotMatch(grokui, /\.\.\.\(p\?\.dir \? \{ dir: p\.dir \} : \{\}\)/);
  assert.match(grokui, /function attachChildDir/);
  assert.match(grokui, /prepareChildDir/);
  assert.doesNotMatch(grokui, /type  \/dir <path>  if you need one/);
});

function fnBody(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = src.match(re);
  assert.ok(m, name + ' exists');
  // Skip the parameter list — waitIdle(sess, { signal, ... }) would otherwise
  // treat the destructuring brace as the function body.
  let i = m.index + m[0].length - 1;
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') {
      parens--;
      if (parens === 0) { i++; break; }
    }
  }
  const brace = src.indexOf('{', i);
  let depth = 0;
  for (let j = brace; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(brace, j + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

test('grokui-app depends on openzoo latest, not a 0.48 caret', () => {
  assert.equal(appPkg.dependencies.openzoo, 'latest');
  const lock = require('../grokui-app/package-lock.json');
  assert.equal(lock.packages[''].dependencies.openzoo, 'latest');
});

test('GPU stays on — do not disableHardwareAcceleration', () => {
  // Software raster made resize painfully slow. Mitigate the renderer
  // SIGTRAP by respawn/reload, not by turning the GPU off.
  assert.doesNotMatch(main, /disableHardwareAcceleration/);
  assert.doesNotMatch(main, /disable-gpu['"`]/);
  const body = fnBody(main, 'createWindow');
  assert.match(body, /backgroundThrottling:\s*false/);
  assert.match(body, /paintWhenInitiallyHidden:\s*true/);
});

test('darwin window-all-closed does not kill grokui or the sidecar', () => {
  const start = main.indexOf("app.on('window-all-closed'");
  const end = main.indexOf("app.on('before-quit'");
  assert.ok(start >= 0 && end > start, 'window-all-closed and before-quit');
  const closed = main.slice(start, end);
  assert.doesNotMatch(closed, /serverProc.*\.kill\(/);
  assert.doesNotMatch(closed, /healer\.stop\(/);
  assert.doesNotMatch(closed, /proxyProc.*\.kill\(/);
  assert.match(closed, /process\.platform !== 'darwin'/);
  assert.match(closed, /app\.quit\(\)/);
  const beforeQuit = main.slice(end, end + 420);
  assert.match(beforeQuit, /quitting = true/);
  assert.match(beforeQuit, /serverProc\.kill\(/);
  assert.match(beforeQuit, /healer\.stop\(/);
  assert.match(beforeQuit, /must not SIGTERM a healthy/);
  assert.doesNotMatch(beforeQuit, /reloadOpenWindows/);
});

test('grokui respawns if it exits while the app is still running', () => {
  const body = fnBody(main, 'startServer');
  assert.match(body, /serverProc\.on\('exit'/);
  assert.match(body, /if \(quitting\) return/);
  assert.match(body, /startServer\(\)/);
  assert.match(body, /reloadOpenWindows/);
  assert.match(main, /function reloadOpenWindows/);
  assert.match(main, /LIVE_URL\}\/threads/);
  assert.match(fnBody(main, 'reloadOpenWindows'), /BrowserWindow\.getAllWindows/);
  assert.match(fnBody(main, 'reloadOpenWindows'), /loadURL\(LIVE_URL\)/);
  const activate = main.slice(main.indexOf("app.on('activate'"), main.indexOf("app.on('window-all-closed'"));
  assert.match(activate, /if \(!serverProc\) startServer\(\)/);
  assert.match(activate, /void ensureProxy\(\)/);
  const ensureAt = activate.indexOf('void ensureProxy()');
  const windowsAt = activate.indexOf('BrowserWindow.getAllWindows()');
  assert.ok(ensureAt >= 0 && windowsAt > ensureAt, 'activate heals even when a window already exists');
});

test('whenReady kicks ensureProxy before createWindow without awaiting it', () => {
  const start = main.indexOf('app.whenReady()');
  const end = main.indexOf("app.on('window-all-closed'");
  assert.ok(start >= 0 && end > start, 'whenReady and window-all-closed');
  const body = main.slice(start, end);
  const ensureAt = body.indexOf('void ensureProxy()');
  const windowAt = body.indexOf('createWindow()');
  assert.ok(ensureAt >= 0, 'whenReady starts ensureProxy');
  assert.ok(windowAt > ensureAt, 'ensureProxy is kicked before createWindow');
  assert.doesNotMatch(body, /await\s+ensureProxy/);
  assert.match(body, /void ensureProxy\(\)/);
});

test('preload exposes heal-sidecar so unreachable UI can respawn :8402', () => {
  assert.match(preload, /healSidecar:/);
  assert.match(preload, /heal-sidecar/);
  assert.match(main, /heal-sidecar/);
  assert.match(main, /void ensureProxy\(\)/);
  assert.match(grokui, /electronAPI\.healSidecar/);
  assert.match(grokui, /function requestSidecarHeal/);
  assert.match(grokui, /sidecar starting…['"]\) requestSidecarHeal|streamStatus === 'sidecar starting…'/);
});

test('render-process-gone and unresponsive reload the live grokui URL', () => {
  assert.match(main, /function attachRendererGuards/);
  const body = fnBody(main, 'attachRendererGuards');
  assert.match(body, /render-process-gone/);
  assert.match(body, /unresponsive/);
  assert.match(body, /loadAppWhenReady/);
  assert.match(body, /startingPage\(\)/);
  assert.match(fnBody(main, 'createWindow'), /attachRendererGuards\(win\)/);
  assert.match(fnBody(main, 'loadLiveOrFailed'), /win\.loadURL\(LIVE_URL\)/);
  assert.doesNotMatch(body, /app\.quit\(\)/);
});

test('APP_HTML fills the electron window on resize (100% not 100vh)', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(appHtml, /html, body \{[^}]*height: 100%;[^}]*width: 100%;[^}]*overflow: hidden/);
  assert.match(appHtml, /#sidebar \{[^}]*height: 100%;/);
  assert.match(appHtml, /#main \{[^}]*flex: 1;[^}]*min-width: 0;[^}]*min-height: 0;[^}]*height: 100%;/);
  assert.doesNotMatch(appHtml, /#sidebar \{[^}]*height:\s*100vh/);
  assert.doesNotMatch(appHtml, /#main \{[^}]*height:\s*100vh/);
  assert.doesNotMatch(appHtml, /height:\s*100vh/);
});

test('createWindow constructs BrowserWindow before ensureProxy or /threads', () => {
  const body = fnBody(main, 'createWindow');
  const bw = body.indexOf('new BrowserWindow');
  assert.ok(bw >= 0, 'createWindow constructs BrowserWindow');
  const before = body.slice(0, bw);
  assert.doesNotMatch(before, /await\s+ensureProxy/);
  assert.doesNotMatch(before, /waitFor\s*\(/);
  assert.doesNotMatch(before, /\/threads/);
  assert.doesNotMatch(main, /spawn\([^)]*npx/);
  assert.match(main, /node_modules',\s*'openzoo',\s*'bin',\s*'openzoo\.js'/);
});

test('loadAppWhenReady does not await ensureProxy or a 402 before grokui', () => {
  const body = fnBody(main, 'loadAppWhenReady');
  assert.match(main, /function startingPage/);
  assert.match(main, /win\.loadURL\(startingPage\(\)\)/);
  assert.match(body, /void ensureProxy\(\)/);
  assert.doesNotMatch(body, /await\s+ensureProxy/);
  assert.doesNotMatch(body, /\/v1\/session/);
  assert.doesNotMatch(body, /await waitFor\(`http:\/\/127\.0\.0\.1:8402/);
  assert.match(body, /loadLiveOrFailed/);
  assert.match(fnBody(main, 'loadLiveOrFailed'), /\/threads/);
  assert.match(main, /void ensureProxy\(\)/);
});

test('loadAppWhenReady paints the server error instead of sitting on starting…', () => {
  assert.match(main, /function failedPage/);
  assert.match(main, /function serverFailDetail/);
  const body = fnBody(main, 'loadAppWhenReady');
  assert.match(body, /loadLiveOrFailed/);
  assert.doesNotMatch(body, /await\s+ensureProxy/);
  const live = fnBody(main, 'loadLiveOrFailed');
  assert.match(live, /failedPage\(serverFailDetail\(\)\)/);
  assert.match(live, /serverExit/);
  assert.match(main, /serverProc\.on\('exit'/);
  assert.match(main, /serverLog/);
  assert.match(fnBody(main, 'startServer'), /stdio:\s*\[\s*'ignore',\s*'pipe',\s*'pipe'\s*\]/);
});

test('GET /v1/models is unpaid — never client.fetch wrap-walk', () => {
  const proxy = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  const start = proxy.indexOf("path === '/v1/models'");
  const end = proxy.indexOf("const probe = req.method === 'GET'", start);
  const block = proxy.slice(start, end);
  assert.match(block, /fetchHeaders/);
  assert.doesNotMatch(block, /await client\.fetch/);
  assert.match(block, /modelsListForRequest\(payload, req\.headers\)/);
  assert.match(block, /modelsListForRequest\(\{ object: 'list', data: \[\] \}/);
});

test('empty-wallet park opens Pay; a generic 402 handshake does not', () => {
  assert.match(grokui, /function isEmptyWalletPayment/);
  assert.match(grokui, /function maybeOpenPayForEmptyWallet/);
  assert.match(grokui, /payneed-btn/);
  assert.match(grokui, /pay\.textContent = 'payment required'/);
  const script = inlineAppScript(grokui).script;
  const add = script.indexOf('function addRow');
  const addFn = script.slice(add, script.indexOf('let lastRenderKey', add));
  assert.match(addFn, /isEmptyWalletPayment\(text\)/);
  assert.match(addFn, /maybeOpenPayForEmptyWallet\(text\)/);
  const appWallet = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(appWallet, /includes\('wallet is empty'\)/);
  assert.doesNotMatch(appWallet, /\\b\(\?:wallet is empty/);
  assert.match(addFn, /openWallet\(\)/);
  assert.doesNotMatch(script, /if \(isPaymentFailed\(text\)\) openWallet/);
  const pod = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');
  assert.match(pod, /isUnderfunded402Body/);
  assert.match(pod, /if \(isUnderfunded402Body\(peek\)\) return r/);
  assert.match(pod, /payment required — HTTP 402, the wallet is empty/);
  assert.doesNotMatch(pod, /payment failed — HTTP 402, the wallet is empty/);
});

test('afterPack fails the pack when copied openzoo is not npm latest', () => {
  const afterPack = require('../grokui-app/build/afterPack.js');
  const published = afterPack.publishedOpenzooVersion();
  assert.match(published, /^\d+\.\d+\.\d+$/);
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-afterpack-'));
  mkdirSync(path.join(dir, 'openzoo'));
  writeFileSync(path.join(dir, 'openzoo', 'package.json'), JSON.stringify({ name: 'openzoo', version: '0.48.97' }));
  assert.throws(() => afterPack.assertCopiedOpenzoo(dir, published), /0\.48\.97/);
  writeFileSync(path.join(dir, 'openzoo', 'package.json'), JSON.stringify({ name: 'openzoo', version: published }));
  assert.doesNotThrow(() => afterPack.assertCopiedOpenzoo(dir, published));
  const src = readFileSync(path.join(root, 'grokui-app', 'build', 'afterPack.js'), 'utf8');
  assert.match(src, /npm view openzoo version/);
  assert.match(src, /npm install openzoo@latest/);
  assert.match(src, /resources',\s*'app'/);
  assert.match(src, /copyRepoLib/);
  assert.match(src, /writeLibEsmPackage/);
  assert.match(src, /assertPackedGrokuiLib/);
  assert.match(src, /assert-esm-relatives\.mjs/);
  assert.match(src, /assert-packed-grokui-esm\.mjs/);
  assert.match(src, /assertPackedNodePty/);
  assert.match(src, /assertPackedOpenzooClaude/);
  assert.match(src, /ensurePackedPtyAndClaude/);
});

test('afterPack pack gate fails when node-pty or its native .node is missing', () => {
  const afterPack = require('../grokui-app/build/afterPack.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-packed-pty-'));
  try {
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    assert.throws(() => afterPack.assertPackedNodePty(dir, {}), /node-pty/);
    mkdirSync(path.join(dir, 'node_modules', 'node-pty'));
    writeFileSync(path.join(dir, 'node_modules', 'node-pty', 'package.json'), JSON.stringify({
      name: 'node-pty', version: '1.1.0', main: 'lib/index.js',
    }));
    mkdirSync(path.join(dir, 'node_modules', 'node-pty', 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'node-pty', 'lib', 'index.js'), 'exports.spawn = () => {};\n');
    assert.throws(() => afterPack.assertPackedNodePty(dir, {}), /\.node/);
    mkdirSync(path.join(dir, 'node_modules', 'node-pty', 'build', 'Release'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), Buffer.from([0]));
    assert.doesNotThrow(() => afterPack.assertPackedNodePty(dir, { arch: 'x64' }));
    assert.throws(() => afterPack.assertPackedOpenzooClaude(dir), /openzoo-claude/);
    mkdirSync(path.join(dir, 'node_modules', 'openzoo-claude', 'v2', 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'openzoo-claude', 'package.json'), JSON.stringify({
      name: 'openzoo-claude', version: '2.0.2',
      bin: { 'openzoo-claude': 'v2/src/index.mjs' },
    }));
    writeFileSync(path.join(dir, 'node_modules', 'openzoo-claude', 'v2', 'src', 'index.mjs'), 'export {}\n');
    assert.throws(() => afterPack.assertPackedOpenzooClaude(dir), /goal\.mjs/);
    mkdirSync(path.join(dir, 'node_modules', 'openzoo-claude', 'v2', 'src', 'ui'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'openzoo-claude', 'v2', 'src', 'goal.mjs'), 'export {}\n');
    writeFileSync(path.join(dir, 'node_modules', 'openzoo-claude', 'v2', 'src', 'ui', 'commands.mjs'), 'export {}\n');
    assert.doesNotThrow(() => afterPack.assertPackedOpenzooClaude(dir));
    assert.throws(() => afterPack.assertPackedNodePty(dir, { electronPlatformName: 'win32' }), /conpty|OpenConsole/);
    writeFileSync(path.join(dir, 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node'), Buffer.from([0]));
    mkdirSync(path.join(dir, 'node_modules', 'node-pty', 'conpty'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'node-pty', 'conpty', 'OpenConsole.exe'), '');
    assert.doesNotThrow(() => afterPack.assertPackedNodePty(dir, { electronPlatformName: 'win32', arch: 'x64' }));
    assert.throws(() => afterPack.assertPackedVendorXterm(dir), /xterm/);
    mkdirSync(path.join(dir, 'lib', 'vendor'), { recursive: true });
    writeFileSync(path.join(dir, 'lib', 'vendor', 'xterm.js'), '/* xterm */\n');
    writeFileSync(path.join(dir, 'lib', 'vendor', 'xterm.css'), '/* css */\n');
    writeFileSync(path.join(dir, 'lib', 'vendor', 'fit.js'), '/* fit */\n');
    assert.doesNotThrow(() => afterPack.assertPackedVendorXterm(dir));
    const gate = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-node-pty.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(gate.status, 0, gate.stderr || gate.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('afterPack copies the whole repo lib and fails if a relative is missing', () => {
  const afterPack = require('../grokui-app/build/afterPack.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-packed-lib-'));
  afterPack.copyRepoLib(dir, path.join(root, 'grokui-app'));
  assert.equal(existsSync(path.join(dir, 'lib', 'info.js')), true);
  assert.equal(existsSync(path.join(dir, 'lib', 'vendor', 'xterm.js')), true);
  assert.equal(existsSync(path.join(dir, 'lib', 'vendor', 'xterm.css')), true);
  assert.equal(existsSync(path.join(dir, 'lib', 'vendor', 'fit.js')), true);
  assert.doesNotThrow(() => afterPack.assertPackedVendorXterm(dir));
  assert.equal(existsSync(path.join(dir, 'lib', 'hrr.js')), true);
  assert.equal(existsSync(path.join(dir, 'lib', 'spill.js')), true);
  assert.equal(existsSync(path.join(dir, 'lib', 'subscription.js')), true);
  assert.equal(existsSync(path.join(dir, 'lib', 'package.json')), true);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'lib', 'package.json'), 'utf8')).type, 'module');
  assert.doesNotThrow(() => afterPack.assertPackedGrokuiLib(dir));
  rmSync(path.join(dir, 'lib', 'info.js'));
  assert.throws(() => afterPack.assertPackedGrokuiLib(dir), /info\.js|missing relative/);
});

test('afterPack overlays sidecar spill/runguard into node_modules/openzoo and bit-compares', () => {
  // copyRepoLib → app/lib is the UI. Packed apps spawn
  // node_modules/openzoo/bin/openzoo.js, so a missing overlay leaves npm's
  // 16k spill in the dmg even though repo lib/spill.js binds at 2k.
  const afterPack = require('../grokui-app/build/afterPack.js');
  const required = ['lib/spill.js', 'lib/runguard.js', 'lib/racesettle.js', 'lib/hrr.js', 'lib/retrieve.js', 'lib/livestatus.js', 'lib/think.js'];
  for (const rel of required) {
    assert.equal(afterPack.OPENZOO_SIDECAR_OVERLAY.includes(rel), true, rel);
  }
  assert.equal(afterPack.OPENZOO_SIDECAR_OVERLAY.includes('lib/proxy.js'), true);
  assert.equal(afterPack.OPENZOO_SIDECAR_OVERLAY.includes('lib/relay.js'), true);
  assert.equal(afterPack.OPENZOO_SIDECAR_OVERLAY.includes('lib/modelroute.js'), true);

  const staged = mkdtempSync(path.join(tmpdir(), 'oz-overlay-nm-'));
  const dest = path.join(staged, 'openzoo');
  mkdirSync(path.join(dest, 'lib'), { recursive: true });
  writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
    name: 'openzoo', version: '0.49.8', type: 'module', files: ['bin', 'lib'],
  }) + '\n');
  writeFileSync(path.join(dest, 'lib', 'spill.js'), 'NPM_16K_SPILL_GATE\n');
  afterPack.overlayRepoOpenzooSidecar(staged, path.join(root, 'grokui-app'));
  for (const rel of afterPack.OPENZOO_SIDECAR_OVERLAY) {
    assert.equal(
      readFileSync(path.join(dest, rel), 'utf8'),
      readFileSync(path.join(root, rel), 'utf8'),
      rel,
    );
  }
  assert.doesNotThrow(() => afterPack.assertOverlaidOpenzoo(dest, root));
  assert.doesNotThrow(() => afterPack.assertPackedLivestatusLoads(dest));
  assert.doesNotThrow(() => afterPack.assertPackedOpenzooLib(dest));
  assert.equal(existsSync(path.join(dest, 'lib', 'think.js')), true);
  assert.equal(afterPack.OPENZOO_SIDECAR_REQUIRED.includes('lib/think.js'), true);
  writeFileSync(path.join(dest, 'lib', 'spill.js'), 'stale npm spill\n');
  assert.throws(() => afterPack.assertOverlaidOpenzoo(dest, root), /spill\.js|differ|overlaid/);
  rmSync(path.join(dest, 'lib', 'runguard.js'));
  assert.throws(() => afterPack.assertOverlaidOpenzoo(dest, root), /runguard\.js/);
});

test('assert-overlaid-openzoo fails a packed tree that still has npm spill.js', () => {
  const afterPack = require('../grokui-app/build/afterPack.js');
  const packed = mkdtempSync(path.join(tmpdir(), 'oz-packed-overlay-'));
  try {
    const dest = path.join(packed, 'resources', 'app', 'node_modules', 'openzoo');
    mkdirSync(path.join(dest, 'lib'), { recursive: true });
    writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: 'openzoo', version: '0.49.8', type: 'module' }) + '\n');
    for (const rel of afterPack.OPENZOO_SIDECAR_OVERLAY) {
      mkdirSync(path.join(dest, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dest, rel), readFileSync(path.join(root, rel)));
    }
    writeFileSync(path.join(dest, 'lib', 'spill.js'), 'NPM_16K_SPILL_GATE\n');
    const bad = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-overlaid-openzoo.mjs'), packed], {
      encoding: 'utf8',
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /spill\.js|overlaid tree|differ/);
    writeFileSync(path.join(dest, 'lib', 'spill.js'), readFileSync(path.join(root, 'lib', 'spill.js')));
    const ok = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-overlaid-openzoo.mjs'), packed], {
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /ok overlaid/);
    const loadOk = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-openzoo-lib.mjs'), packed], {
      encoding: 'utf8',
    });
    assert.equal(loadOk.status, 0, loadOk.stderr || loadOk.stdout);
    rmSync(path.join(dest, 'lib', 'think.js'));
    const missingThink = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-openzoo-lib.mjs'), packed], {
      encoding: 'utf8',
    });
    assert.notEqual(missingThink.status, 0);
    assert.match(missingThink.stderr, /think\.js/);
  } finally {
    rmSync(packed, { recursive: true, force: true });
  }
});

test('desktop pack CI walks packed grokui.mjs relatives', () => {
  for (const name of ['grokui-macos.yml', 'grokui-linux.yml', 'grokui-windows.yml']) {
    const yml = readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
    assert.match(yml, /assert-packed-grokui-lib\.mjs/);
    assert.match(yml, /assert-overlaid-openzoo\.mjs/);
    assert.match(yml, /assert-packed-openzoo-lib\.mjs/);
    assert.match(yml, /assert-packed-node-pty\.mjs/);
    assert.match(yml, /assert-app-html-script\.mjs/);
  }
  // 1.6.5 tag CI: mac/win Build died on bigint-buffer node-gyp before afterPack.
  // mac: Python 3.12+ has no distutils. win: windows-latest is VS 2026.
  // 1.6.6 win #92: windows-2022 still has no setuptools — same distutils miss.
  const macYml = readFileSync(path.join(root, '.github', 'workflows', 'grokui-macos.yml'), 'utf8');
  const winYml = readFileSync(path.join(root, '.github', 'workflows', 'grokui-windows.yml'), 'utf8');
  assert.match(macYml, /setuptools/);
  assert.match(macYml, /distutils/);
  assert.match(winYml, /runs-on:\s*windows-2022/);
  assert.doesNotMatch(winYml, /runs-on:\s*windows-latest/);
  assert.match(winYml, /setup-python/);
  assert.match(winYml, /setuptools/);
  assert.match(winYml, /distutils/);
  assert.match(winYml, /py -m pip install setuptools/);
  const packed = readFileSync(path.join(root, 'scripts', 'assert-packed-grokui-lib.mjs'), 'utf8');
  assert.match(packed, /assert-packed-grokui-esm\.mjs/);
  const ozLib = readFileSync(path.join(root, 'scripts', 'assert-packed-openzoo-lib.mjs'), 'utf8');
  assert.match(ozLib, /lib\/think\.js/);
  assert.match(ozLib, /assertPackedOpenzooLib/);
  const ignore = readFileSync(path.join(root, 'grokui-app', '.gitignore'), 'utf8');
  assert.match(ignore, /^lib\/$/m);
  assert.doesNotMatch(ignore, /lib\/grokui\.mjs/);
  const rel = readFileSync(path.join(root, 'scripts', 'release-mac.sh'), 'utf8');
  assert.match(rel, /assert-packed-grokui-lib/);
  assert.match(rel, /assert-overlaid-openzoo/);
  assert.match(rel, /assert-packed-openzoo-lib/);
});

test('assert-packed-grokui-lib fails a 1.5.86-shaped packed tree', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-packed-walk-'));
  try {
    mkdirSync(path.join(dir, 'lib'));
    for (const f of ['grokui.mjs', 'podagent.mjs', 'livestatus.js', 'worktree.mjs', 'racesettle.js']) {
      cpSync(path.join(root, 'lib', f), path.join(dir, 'lib', f));
    }
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-grokui-lib.mjs'), dir], {
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /info\.js|FAIL: packed relatives missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assert-packed-grokui-esm fails a 1.5.87 CJS lib (no type:module)', () => {
  // Reproduce the packaged tree: parent package.json is CJS (like grokui-app
  // main.js). Without lib/package.json {"type":"module"}, named imports from
  // livestatus.js throw "is a CommonJS module" — that is 1.5.87 on :4173.
  const app = mkdtempSync(path.join(tmpdir(), 'oz-packed-cjs-'));
  try {
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'openzoo-grokui', main: 'main.js' }) + '\n');
    const lib = path.join(app, 'lib');
    cpSync(path.join(root, 'lib'), lib, { recursive: true });
    rmSync(path.join(lib, 'package.json'), { force: true });
    const missing = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-grokui-esm.mjs'), lib], {
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /package\.json missing|type is not module|is a CommonJS module/);
    writeFileSync(path.join(lib, 'package.json'), '{\n  "type": "module"\n}\n');
    const ok = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-grokui-esm.mjs'), lib], {
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /type=module/);
    assert.match(ok.stdout, /ok dry import/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('desktop grokui ships dugite so Finder has git without PATH', () => {
  assert.ok(ozPkg.dependencies.dugite, 'openzoo depends on dugite');
  assert.ok(appPkg.dependencies.dugite, 'packaged grokui-app depends on dugite');
  const afterPack = readFileSync(path.join(root, 'grokui-app', 'build', 'afterPack.js'), 'utf8');
  assert.match(afterPack, /ensureDugiteGit/);
  assert.match(afterPack, /download-git\.js/);
  const wt = readFileSync(path.join(root, 'lib', 'worktree.mjs'), 'utf8');
  assert.match(wt, /from 'dugite'/);
  assert.match(wt, /setupEnvironment/);
  assert.match(wt, /bundledGitPath/);
  assert.doesNotMatch(wt, /bin:\s*'git'/);
  assert.match(wt, /will not call PATH git/);
});

test('pay modal lists the card subscribe lane before wallet/x402', () => {
  const start = grokui.indexOf('id="walletOverlay"');
  const end = grokui.indexOf('id="main"', start);
  const modal = grokui.slice(start, end);
  const card = modal.indexOf('id="subLane"');
  const x402 = modal.indexOf('id="walletBody"');
  assert.ok(card >= 0, 'subscribe/card lane is in the pay modal');
  assert.ok(x402 >= 0, 'wallet/x402 body is in the pay modal');
  assert.ok(card < x402, 'card lane must appear before wallet/x402');
  assert.match(modal, /<h3>Pay with a card<\/h3>/);
  assert.doesNotMatch(modal, /<h3>Your wallet<\/h3>/);
  assert.match(modal, /local burner on this machine/);
  assert.match(modal, /Subscribe with a card/);
});

test('header pay button is not labeled only wallet', () => {
  const m = grokui.match(/id="walletBtn"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(m, 'header pay control exists');
  assert.doesNotMatch(m[0], />\s*wallet\s*</i);
  assert.match(m[0], />pay</);
  assert.match(m[0], /Pay with a card/);
});

test('ping-all wakes the crew without a prompt or /all modal', () => {
  // window.prompt is missing/blocked in Electron, so a prompt here made the
  // only UI ping path a silent no-op. Default click is /ping — a wake.
  assert.match(grokui, /function wakeOnPing/);
  assert.match(grokui, /function kickTurn/);
  assert.match(grokui, /task: '\/ping'/);
  assert.match(grokui, /title="Wake all '/);
  const script = inlineAppScript(grokui).script;
  const pingAt = script.indexOf("const pingBtn = row.querySelector('.trow-ping')");
  assert.notEqual(pingAt, -1);
  const pingHandler = script.slice(pingAt, script.indexOf("row.querySelector('.tclose')", pingAt));
  assert.doesNotMatch(pingHandler, /prompt\s*\(/);
  assert.doesNotMatch(pingHandler, /task: '\/all /);
  assert.match(pingHandler, /task: '\/ping'/);
  assert.match(grokui, /wake idle bots below you/);
  assert.match(grokui, /Never childKickoff/);
  const wakeAt = grokui.indexOf('function wakeOnPing');
  const wakeFn = grokui.slice(wakeAt, grokui.indexOf('// Ceiling on subagents', wakeAt));
  assert.doesNotMatch(wakeFn, /childKickoff\s*\(/);
  assert.match(wakeFn, /pingWakeText/);
});

test('wallet modal offers Stripe subscriptions next to x402', () => {
  assert.match(grokui, /Subscribe with a card/);
  assert.match(grokui, /Subscription key · no x402/);
  assert.match(grokui, /Most teams want this/);
  assert.match(grokui, /I already subscribed — paste key/);
  assert.match(grokui, /\/billing\/tiers/);
  assert.match(grokui, /\/billing\/checkout/);
  assert.match(grokui, /\/billing\/key\?session=/);
  assert.match(grokui, /SUBSCRIPTIONS_PAGE/);
  const sub = readFileSync(path.join(root, 'lib', 'subscription.js'), 'utf8');
  assert.match(sub, /https:\/\/zoo\.openzoo\.fun\/subscriptions/);
  assert.match(grokui, /window\.open\(url, '_blank'/);
  assert.match(grokui, /id="hSub"/);
  assert.match(grokui, /subscriptionPublicView/);
  assert.doesNotMatch(grokui, /\$9\/mo/);
  assert.doesNotMatch(grokui, /id="assetsBtn"/);
  assert.match(main, /shell\.openExternal/);
  const pay = readFileSync(path.join(root, 'lib', 'pay.js'), 'utf8');
  assert.match(pay, /applySubscriptionHeaders/);
  assert.match(pay, /stripAuthorization/);
});

test('thread avatars are illustrated bot faces, not two-letter initials', () => {
  // Grok Bot paints a cute PFP per agent. Two letters in a flat circle is the
  // thing we are replacing — a grep that still allows initials(t.name) would
  // let that painter come back.
  assert.match(grokui, /function botPfp/);
  assert.match(grokui, /function botFaceInner/);
  assert.match(grokui, /function nameHash/);
  assert.match(grokui, /class="bot-pfp"/);
  assert.match(grokui, /@keyframes botbob/);
  assert.match(grokui, /@keyframes botblink/);
  assert.match(grokui, /botPfp\(t\.name, t\.members\)/);
  assert.doesNotMatch(grokui, /function initials\s*\(/);
  assert.doesNotMatch(grokui, /initials\s*\(\s*t\.name\s*\)/);
  assert.doesNotMatch(grokui, /initials\s*\(\s*name\s*\)/);
  assert.doesNotMatch(grokui, /name\.slice\(0,\s*2\)\.toUpperCase\(\)/);
  assert.doesNotMatch(grokui, /gravatar|dicebear|ui-avatars|unavatar|pravatar/i);
  const script = inlineAppScript(grokui).script;
  assert.match(script, /<svg class="bot-pfp"/);
  assert.equal((script.match(/botPfp\(/g) || []).length >= 5, true);
  const fnStart = grokui.indexOf('  let botPfpSeq = 0;');
  const fnEnd = grokui.indexOf('  // SEARCH.', fnStart);
  const fns = grokui.slice(fnStart, fnEnd);
  const api = Function(fns + '; return { botPfp: botPfp, nameHash: nameHash };')();
  const a = api.botPfp('Alpha');
  const a2 = api.botPfp('Alpha');
  const b = api.botPfp('Beta');
  const crew = api.botPfp('Alpha, Beta, Gamma');
  assert.match(a, /^<svg class="bot-pfp"/);
  assert.match(a, /<circle /);
  assert.doesNotMatch(a, />[A-Z]{2}</);
  assert.equal(a.replace(/id="bfg\d+"/g, 'id="bfg"').replace(/url\(#bfg\d+\)/g, 'url(#bfg)'),
    a2.replace(/id="bfg\d+"/g, 'id="bfg"').replace(/url\(#bfg\d+\)/g, 'url(#bfg)'));
  assert.notEqual(a.replace(/id="bfg\d+"/g, ''), b.replace(/id="bfg\d+"/g, ''));
  assert.equal((crew.match(/class="bot-bob"/g) || []).length, 3);
  assert.equal(api.nameHash('Alpha'), api.nameHash('Alpha'));
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

test('HUD embers when session cogs exceed paid; launched racers stay billed', () => {
  assert.match(grokui, /cogsOver/);
  assert.match(grokui, /cogs above paid/);
  assert.match(grokui, /you pay for every entrant we actually launched/);
  assert.match(grokui, /failures still cost us/);
  assert.doesNotMatch(grokui, /unused grant-back should have kept used cogs/);
  const proxy = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  assert.match(proxy, /receiptUsedCogs/);
  assert.doesNotMatch(proxy, /MARKUP\s*=\s*3/);
  const settle = readFileSync(path.join(root, 'lib', 'racesettle.js'), 'utf8');
  assert.match(settle, /race_unused/);
  assert.match(settle, /receiptUsedCogs/);
  assert.match(settle, /not a user refund/);
  assert.doesNotMatch(settle, /markup\s*=\s*3/);
  assert.doesNotMatch(settle, /billedRaw\s*\/\s*markup/);
  assert.match(settle, /function recutRaceByHud/);
  assert.match(settle, /RACE_HUD_TARGET/);
  const brain = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');
  assert.match(brain, /does not grant unused or failed racers back/);
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

test('a race streams the live racer and can replace the bubble once', () => {
  assert.match(grokui, /ev\.replace/);
  assert.match(grokui, /brainRace\(callMsgs, emit, t\.contextId, models, need, undefined, emitStatus/);
  assert.match(grokui, /tier: t\.tier \|\| 'medium'/);
  assert.match(grokui, /function kickTurn/);
  assert.match(grokui, /emitToThread\(threadId, ev\)/);
  const brain = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');
  assert.match(brain, /createRaceFeed/);
  assert.match(brain, /classifyRaceAnswer/);
  assert.match(brain, /raceLastShip/);
  assert.match(brain, /race_need/);
  assert.match(brain, /probeGatewayRace/);
  assert.match(brain, /brainGatewayRace/);
  assert.match(brain, /hooks\.onRace/);
  assert.match(brain, /feed\.judge\(\)/);
  assert.doesNotMatch(brain, /if \(!cands\.length\) return '';/);
  assert.doesNotMatch(brain, /Streaming is deliberately not forwarded/);
  const live = readFileSync(path.join(root, 'lib', 'livestatus.js'), 'utf8');
  assert.match(live, /racing \$\{b\}\/\$\{n\} back/);
  assert.match(live, /RACE_EVERY_FAILED/);
  assert.match(live, /fetch failed/);
  assert.match(live, /function shortModelName/);
  assert.match(live, /phase = 'judging'/);
});

test('in-flight race paints a spectator grid and a classifier beat, not mute status', () => {
  assert.match(grokui, /type: 'race'/);
  assert.match(grokui, /onRace:/);
  assert.match(grokui, /liveRace/);
  assert.match(grokui, /function raceGridHtml/);
  assert.match(grokui, /function raceIsLive/);
  assert.match(grokui, /r\.racers\.length >= 2/);
  assert.match(grokui, /class="racegrid n'/);
  assert.match(grokui, /race\.recut \? ' · recut'/);
  assert.match(grokui, /class="racejudge/);
  assert.match(grokui, /looking at the '/);
  assert.match(grokui, /goes to '/);
  assert.match(grokui, /class="racefail"/);
  assert.match(grokui, /abandoned/);
  assert.match(grokui, /bubble\.raceboard/);
  assert.doesNotMatch(grokui, /id="assetsBtn"/);
  assert.match(grokui, /function placeHud/);
  assert.doesNotMatch(grokui, /#hud \{[^}]*top:\s*40px/);
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

test('canvas folds reasoning behind a collapsed thinking row, not the Auto chip', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(grokui, /from '\.\/think\.js'/);
  assert.match(grokui, /type: 'think'/);
  assert.match(grokui, /takeThink/);
  assert.match(appHtml, /function splitThinkTags/);
  assert.match(appHtml, /function makeThinkFold/);
  assert.match(appHtml, /thinking\.\.\./);
  assert.match(appHtml, /'thought'/);
  assert.match(appHtml, /className = 'thinkfold'/);
  assert.match(appHtml, /className = 'thinkchip'/);
  assert.match(appHtml, /liveThinkOpen/);
  assert.match(appHtml, /ev\.type === 'think'/);
  assert.match(appHtml, /body\.textContent = liveThinkOpen \? text : ''/);
  assert.match(appHtml, /Not the Agent run-mode chip/);
  assert.doesNotMatch(appHtml, /class="thinkchip modebtn/);
  assert.doesNotMatch(appHtml, /id="modeAgent".*thinkfold/);
  assert.match(appHtml, />Chat</);
  assert.match(appHtml, />Agent</);
  assert.doesNotMatch(appHtml, /id="modeAgent"[^>]*>auto</i);
  assert.doesNotMatch(appHtml, /id="modeAgent"[^>]*>Auto</);
  // Live Agent: thinking… chip stays visible even before the first token.
  assert.match(appHtml, /fold\.hidden = false/);
  assert.match(appHtml, /function foldBodyText/);
  assert.match(appHtml, /ev\.type === 'tool'/);
  assert.match(appHtml, /ev\.type === 'spawn'/);
  assert.match(appHtml, /streamTools/);
  assert.match(appHtml, /function scrubBotText/);
  assert.match(appHtml, /upstream HTTP /);
  // Live bubble is model text only — no RUN/WRITE trails, no mute CoT dump.
  assert.match(appHtml, /b\.textContent = scrubBotText\(parts\.visible\)/);
  assert.doesNotMatch(appHtml, /b\.textContent = streamBuf;/);
  assert.doesNotMatch(appHtml, /class="ttrail"/);
});

test('paintStream snapshots near-bottom before growing the live bubble', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  const start = appHtml.indexOf('function pinLogBottom()');
  const paint = appHtml.indexOf('function paintStream()', start);
  const end = appHtml.indexOf('function connectStream(', paint);
  assert.ok(start >= 0 && paint > start && end > paint, 'pinLogBottom/paintStream bounds');
  const helpers = appHtml.slice(start, paint);
  const fn = appHtml.slice(paint, end);
  const snap = fn.indexOf('const wasNearBottom = log.scrollHeight - log.scrollTop - log.clientHeight');
  const writeText = fn.indexOf('b.textContent = scrubBotText(parts.visible)');
  const writeHtml = fn.indexOf('b.innerHTML = liveBubbleHtml()');
  assert.ok(snap >= 0, 'snapshots wasNearBottom before mutating the bubble');
  assert.ok(writeText > snap, 'textContent write is after the snapshot');
  assert.ok(writeHtml > snap, 'innerHTML write is after the snapshot');
  assert.match(fn, /if \(wasNearBottom \|\| followLive\) pinLogBottom\(\)/);
  assert.match(helpers, /requestAnimationFrame/);
  assert.doesNotMatch(fn, /if \(log\.scrollHeight - log\.scrollTop - log\.clientHeight < 140\) log\.scrollTop = log\.scrollHeight/);
});

test('SYSTEM and Auto refuse shelling the :8402 proxy; site curls stay allowed', () => {
  assert.match(grokui, /const CHAT_NOT_PROXY/);
  assert.match(grokui, /You already ARE the chat/);
  assert.match(grokui, /Never RUN curl, wget, or fetch against localhost:8402/);
  assert.match(grokui, /Orange Auto = WRITE \/ READ \/ RUN \/ GLOB/);
  assert.match(grokui, /Never mkdir empty trees and declare DONE/);
  assert.match(grokui, /function looksLikeProxyShell/);
  assert.match(grokui, /if \(looksLikeProxyShell\(command\)\) return Promise\.resolve\(PROXY_SHELL_REFUSE\)/);
  assert.match(grokui, /extras\.push\(\{ role: 'system', content: CHAT_NOT_PROXY \}\)/);
  assert.match(grokui, /\{ role: 'system', content: CHAT_NOT_PROXY \}/);
  assert.match(grokui, /\$\{CHAT_NOT_PROXY\}/);
  assert.doesNotMatch(grokui, /YOUR OWN paid openzoo calls/);
  assert.doesNotMatch(grokui, /Via RUN you can also make/);
  assert.doesNotMatch(grokui, /Authorization: Bearer sk-openzoo/);
  // Preview curls of the site must still be taught.
  assert.match(grokui, /curl -s localhost:8080/);
});

test('canvas collapses completed RUN cards like thinking, not as the message', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(appHtml, /function makeRunFold/);
  assert.match(appHtml, /function parseLegacyRun/);
  assert.match(appHtml, /function runFoldLabel/);
  assert.match(appHtml, /className = 'runfold'/);
  assert.match(appHtml, /className = 'runchip'/);
  assert.match(appHtml, /return 'ran'/);
  assert.match(appHtml, /return 'running\.\.\.'/);
  assert.match(appHtml, /runcard\.folded/);
  assert.match(appHtml, /h\.runId \|\| h\.runStatus/);
  assert.match(appHtml, /parseLegacyRun\(h\.text\)/);
  assert.match(grokui, /runStatus: 'done', runOutput: output/);
  assert.match(grokui, /text: command, runStatus: 'done', runOutput: output/);
  // Auto lastReply stays `$ cmd\\noutput` for shouldKeepAuto / empty-run hops.
  assert.match(grokui, /const shown = `\$ \$\{command\}\\n\$\{output\}`/);
  assert.match(grokui, /lastReply = shown/);
  // Approve/Deny stay on pending cards.
  assert.match(appHtml, /run\.id && st === 'pending'/);
  assert.match(appHtml, /textContent = 'Approve'/);
});

test('grokui chat does not dump raw 0x6a wrap simulation logs', () => {
  const brain = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');
  assert.match(brain, /function sanitizeProxiedError/);
  assert.match(brain, /wrap ix has too few accounts \(need 9\)/);
  assert.match(brain, /sanitizeProxiedError\(j\?\.error\?\.message\)/);
});

test('ensureProxy reuses a healthy :8402 and autoheals a dead packed sidecar', () => {
  const heal = readFileSync(path.join(root, 'grokui-app', 'sidecar-heal.js'), 'utf8');
  const src = main + '\n' + heal;
  assert.match(src, /function portOccupied/);
  assert.match(src, /Reuse only a healthy :8402/);
  // Occupied-port + hung session is NOT reuse — ping must time out.
  assert.match(src, /not reusing a wedged proxy/);
  assert.match(heal, /displacing then spawning/);
  assert.match(src, /Ping must time out/);
  // Occupied+healthy is not enough: compare listener version to shipped openzoo.
  assert.doesNotMatch(main, /if \(await pingUrl\('http:\/\/127\.0\.0\.1:8402\/v1\/session'\)\) return/);
  assert.match(src, /sidecarIsAttachable\(\{ listenerVersion:/);
  assert.match(main, /function expectedOpenzooVersion/);
  assert.match(main, /path\.join\(__dirname, '\.\.', 'package\.json'\)/);
  assert.match(main, /path\.join\(__dirname, 'node_modules', 'openzoo', 'package\.json'\)/);
  assert.match(src, /expected\/shipped version/);
  assert.match(src, /stale sidecar/);
  assert.match(src, /not attaching; grokui will spawn the matching one/);
  assert.match(src, /refusing to attach/);
  assert.match(src, /displaceStaleListener/);
  assert.match(src, /spawn\(execPath, \[binPath\]|spawn\(spec\.cmd, spec\.args/);
  assert.match(src, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(src, /OPENZOO_SILENT: '1'/);
  assert.match(src, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(src, /node_modules', 'openzoo', 'bin', 'openzoo\.js'/);
  assert.doesNotMatch(src, /npx openzoo@latest/);
  assert.match(src, /sidecar exited/);
  assert.match(src, /respawning/);
  assert.match(heal, /looksLikeModuleNotFound|isCannotLoadOutput/);
  assert.match(heal, /MODULE_NOT_FOUND/);
  assert.match(heal, /falling back to host node|resolveHostNode/);
  assert.match(heal, /\.local['"`].*bin|localBinNode/);
  assert.match(heal, /detached:\s*true/);
  assert.match(heal, /win32NeedsShell|\.cmd\|bat|shell:\s*true/);
  assert.match(heal, /detached \+ piped stdio hangs|win32DetachedPipeHang/);
  assert.match(main, /copyPackedRuntimeToHome/);
  assert.match(heal, /Do not SIGTERM a healthy detached sidecar|must not SIGTERM/);
  assert.doesNotMatch(heal, /timer\.unref/);
  assert.doesNotMatch(heal, /reloadOpenWindows/);
  assert.doesNotMatch(heal, /app\.quit\(/);
  assert.match(main, /createSidecarHealer/);
  assert.match(main, /paymentRequired/);
  assert.match(main, /Do not reload/);
  const proxy = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  const session = proxy.slice(proxy.indexOf("=== '/v1/session'"), proxy.indexOf("=== '/v1/wallet'"));
  assert.match(session, /version,/);
  assert.match(proxy, /OPENZOO_SILENT === '1'/);
});

test('cut and release scripts keep openzoo latest or refuse', () => {
  const cut = readFileSync(path.join(root, 'scripts', 'cut-grokui.mjs'), 'utf8');
  const rel = readFileSync(path.join(root, 'scripts', 'release-mac.sh'), 'utf8');
  assert.match(cut, /dependencies\.openzoo = 'latest'/);
  assert.match(cut, /refuse to cut/);
  assert.match(cut, /assert-packed-grokui-esm\.mjs/);
  assert.match(cut, /assert-overlaid-openzoo\.mjs/);
  assert.match(cut, /assert-packed-openzoo-lib\.mjs/);
  assert.match(cut, /bundle-grokui\.js/);
  assert.match(rel, /assert-grokui-pin/);
  assert.match(rel, /assert-overlaid-openzoo/);
  const missing = spawnSync(process.execPath, [path.join(root, 'scripts', 'cut-grokui.mjs'), '--grokui', '1.5.84'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /refuse to cut/);
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

test('user turns persist to the thread store before the model call', () => {
  assert.match(grokui, /function persistUserTurn/);
  assert.match(grokui, /function visibleHistory/);
  assert.match(grokui, /function isVisibleHistoryEntry/);
  assert.match(fnBody(grokui, 'saveThreads'), /fsyncSync/);
  const run = fnBody(grokui, 'runTurn');
  const persistAt = run.indexOf('persistUserTurn(t, userText, images)');
  const thinkAt = run.indexOf("t.status = 'thinking'");
  assert.ok(persistAt >= 0 && thinkAt > persistAt, 'persist before thinking / model await');
  assert.doesNotMatch(run, /t\.history\.push\(images && images\.length \? \{ who: 'user'/);
  const autoAt = run.indexOf('openzoo claude');
  assert.ok(autoAt >= 0);
  const autoSlice = run.slice(autoAt);
  const claudeAt = autoSlice.indexOf('runAutoClaudeTurn');
  assert.ok(claudeAt > 0);
  const beforeClaude = autoSlice.slice(0, claudeAt);
  assert.match(beforeClaude, /persistUserTurn\(t, userText, images\)/);
  assert.match(beforeClaude, /saveThreads\(\)/);
  assert.match(grokui, /function isClaudeFallbackReply/);
  assert.match(fnBody(grokui, 'isClaudeFallbackReply'), /\(no response\)/);
  assert.match(fnBody(grokui, 'isClaudeFallbackReply'), /upstream HTTP \\d\+/);
  assert.match(fnBody(grokui, 'isClaudeFallbackReply'), /Auto is starting/);
  assert.match(run, /isAutoPtyPending/);
  assert.match(run, /usedClaude = true/);
  assert.doesNotMatch(run, /claudeFallback = true/);
  assert.match(run, /hasLiveClaudeSession/);
  assert.match(run, /!claudeFallback && shouldKeepAuto/);
  assert.match(grokui, /function threadHasVisibleBotReply/);
  assert.match(grokui, /function autoClaudeTurnProducedVisible/);
  assert.match(run, /isAutoPtyPending/);
  assert.doesNotMatch(run, /if \(threadHasVisibleBotReply\(t\)\)/);
  const driveStart = grokui.indexOf("req.url === '/drive'");
  const driveEnd = grokui.indexOf('res.writeHead(200, { \'content-type\': \'text/html\' })', driveStart);
  const drive = grokui.slice(driveStart, driveEnd);
  const flushAt = drive.indexOf('persistUserTurn(t, task, images)');
  const afterFlush = drive.slice(flushAt);
  const ackAt = afterFlush.indexOf("ack(true, { persisted: true })");
  const kickAt = afterFlush.indexOf('runTurn(threadId, task');
  const agentSkip = afterFlush.indexOf('if (isAgentMode(t))');
  assert.ok(flushAt >= 0 && ackAt >= 0, '/drive persists, then ACKs');
  assert.ok(agentSkip > ackAt && agentSkip < kickAt, '/drive Agent returns without runTurn');
  assert.ok(kickAt > agentSkip, 'Chat still runTurn after the Agent early return');
  assert.match(grokui, /history: visibleHistory\(t\.history\)/);
  assert.match(fnBody(grokui, 'loadThreads'), /t\.history = t\.history\.filter\(isVisibleHistoryEntry\)/);
});

test('compose box keeps the draft until persist; AUTO continue is never a user bubble', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(appHtml, /let pendingTurns = \[\]/);
  assert.match(appHtml, /function isHarnessUserText/);
  assert.match(appHtml, /pendingTurns\.push/);
  const submitStart = appHtml.indexOf('async function submit()');
  const submitEnd = appHtml.indexOf("inp.addEventListener('input'", submitStart);
  const submitFn = appHtml.slice(submitStart, submitEnd);
  const afterSitrep = submitFn.slice(submitFn.indexOf('openSitrep()'));
  const addRowAt = afterSitrep.indexOf("addRow('user'");
  const fetchAt = afterSitrep.indexOf("await fetch(API + '/drive'");
  const clearAt = afterSitrep.indexOf("inp.value = ''", fetchAt);
  assert.ok(addRowAt >= 0 && addRowAt < fetchAt, 'optimistic user bubble before /drive');
  assert.ok(fetchAt >= 0 && clearAt > fetchAt, 'do not clear the composer until persist ACK');
  assert.match(afterSitrep.slice(0, fetchAt), /pendingTurns\.push/);
  assert.match(submitFn, /persisted = r\.ok && body\.persisted !== false/);
  assert.match(submitFn, /inp\.value = draft/);
  assert.match(appHtml, /if \(h\.who === 'user' && isHarnessUserText\(h\.text\)\) continue/);
  assert.match(appHtml, /s\.indexOf\('AUTO is still on '/);
  assert.doesNotMatch(appHtml, /AUTO is still on — do not stop/);
  assert.match(appHtml, /function rememberUserTurn/);
  assert.match(appHtml, /function recalledUserTurn/);
  assert.match(appHtml, /function ensureLiveBotRow/);
  assert.match(appHtml, /openzoo\.userTurn\./);
  const paintStart = appHtml.indexOf('function paintStream()');
  const paintFn = appHtml.slice(paintStart, appHtml.indexOf('function connectStream', paintStart));
  assert.doesNotMatch(paintFn, /if \(!b\) \{ render\(\); return; \}/);
  assert.match(paintFn, /ensureLiveBotRow/);
});

test('Agent TUI is packed OCC in xterm, not a second harness or chat-fold fallback', () => {
  const appHtml = grokui.slice(grokui.indexOf('const APP_HTML'), grokui.indexOf('const server = http.createServer'));
  assert.match(grokui, /from '\.\/packed-runtime\.js'/);
  assert.match(grokui, /resolvePackedOpenzooClaude\(\{ env, execPath \}\) \|\| resolveOpenzooClaude\(env\)/);
  assert.match(grokui, /if \(resolved\.via === 'packed'\) ptyEnv\.ELECTRON_RUN_AS_NODE = '1'/);
  assert.match(fnBody(grokui, 'ensureAgentPty'), /if \(cur && !cur\.dead\) return cur/);
  assert.doesNotMatch(fnBody(grokui, 'ensureAgentPty'), /cwd mismatch|killAgentPty/);
  assert.match(grokui, /killAgentPty\(t\.id\)/);
  assert.match(grokui, /reset: true/);
  assert.match(grokui, /\/threads\\\/\(\[\^\/\]\+\)\\\/pty/);
  assert.match(grokui, /\/threads\\\/\(\[\^\/\]\+\)\\\/pty-size/);
  assert.match(grokui, /VENDOR_FILES/);
  assert.match(grokui, /runMode: p\?\.runMode \|\| 'agent'/);
  assert.match(grokui, /\['agents', 'tasks', 'context', 'model', 'goal'\]/);
  assert.match(grokui, /\/model openzoo\/auto/);
  assert.match(grokui, /\/model x-ai\/grok-4\.6/);
  assert.match(appHtml, /#agentTerm \{ flex: 1; min-height: 0; display: none; \}/);
  assert.match(appHtml, /body\.agent-mode #agentTerm \{ display: flex; flex-direction: column; overflow: hidden; \}/);
  assert.match(appHtml, /body\.agent-mode #log \{ display: none; \}/);
  assert.doesNotMatch(appHtml, /body\.agent-mode #row-input \{ display: none/);
  assert.match(appHtml, /body\.agent-mode #bar \{ position: absolute; left: 0; right: 0; bottom: 0;/);
  assert.match(appHtml, /disableStdin:\s*true/);
  assert.doesNotMatch(appHtml, /agentTerm\.onData/);
  assert.match(appHtml, /dirPickBtn/);
  assert.match(appHtml, /electronAPI\.pickDirectory/);
  assert.match(appHtml, /echoSlash\('\/dir ' \+ dir\)/);
  assert.match(appHtml, /body: task \+ String\.fromCharCode\(13\)/);
  assert.match(appHtml, /body: String\.fromCharCode\(27\)/);
  assert.match(appHtml, /Esc in the TUI interrupts/);
  assert.doesNotMatch(appHtml, /#agentTerm \.xterm-screen \{[^}]*height:\s*100%\s*!important/);
  assert.match(appHtml, /window\._ozFitAgent/);
  assert.match(appHtml, /el\.clientHeight < 40/);
  assert.match(appHtml, /setTimeout\(fitAgentTerm, 160\)/);
  assert.match(appHtml, /key !== lastPtySize/);
  assert.match(appHtml, /\/vendor\/xterm\.js/);
  assert.match(appHtml, /\/vendor\/fit\.js/);
  assert.match(appHtml, /\/vendor\/xterm\.css/);
  assert.doesNotMatch(appHtml, /"\\r"/);
  assert.doesNotMatch(appHtml, /'\\r'/);
  assert.ok(existsSync(path.join(root, 'lib', 'vendor', 'xterm.js')));
  assert.ok(existsSync(path.join(root, 'lib', 'vendor', 'xterm.css')));
  assert.ok(existsSync(path.join(root, 'lib', 'vendor', 'fit.js')));
  const afterPack = readFileSync(path.join(root, 'grokui-app', 'build', 'afterPack.js'), 'utf8');
  assert.match(afterPack, /assertPackedVendorXterm/);
  assert.match(afterPack, /v2\/src\/goal\.mjs/);
  assert.match(afterPack, /v2\/src\/ui\/commands\.mjs/);
  assert.match(afterPack, /assertWindowsConptyFiles/);
  const src = grokui.replace(/\r\n/g, '\n');
  const start = src.indexOf('const APP_HTML = `');
  const end = src.indexOf('`;\n\nconst server = http.createServer', start);
  const literal = src.slice(start + 'const APP_HTML = '.length, end + 1);
  const html = Function('SUBSCRIPTIONS_PAGE', 'return ' + literal)('https://example.test/subscriptions');
  const script = inlineAppScript(html).script.replace(/^<script>/, '');
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-agent-apphtml-'));
  try {
    const file = path.join(dir, 'apphtml.js');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

