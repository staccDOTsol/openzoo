import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  assert.match(grokui, /value="grok4.6"/);
  assert.match(grokui, />grok 4.6</);
  assert.match(grokui, /id="raceSel"/);
  assert.match(grokui, /id="walletBtn"/);
  assert.match(grokui, /id="headerDials"/);
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
  assert.match(grokui, /\^\\\/sitrep\\b/);
  assert.match(grokui, /Drawer-only\. Never dump sitrep into the transcript/);
  assert.match(grokui, /if \(c\.name === '\/sitrep'\)/);
  assert.match(grokui, /sitrepRow\('race'/);
  assert.match(grokui, /sitrepRow\('paid calls'/);
  assert.match(grokui, /sitrepRow\('prepaid', \(Number\(you\.creditUsd\) > 0\) \? 'yes' : 'no'\)/);
  assert.doesNotMatch(grokui, /formatSitrep/);
  assert.doesNotMatch(grokui, /task: '\/sitrep'/);
  assert.doesNotMatch(grokui, /sitrepRow\('subscription'/);
  assert.doesNotMatch(grokui, /sitrep.*npmrc/i);
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
  assert.match(grokui, /const AUTO_RACE_RETRY/);
  assert.match(grokui, /const AUTO_EMPTY_RETRY/);
  assert.match(grokui, /STALLED_OFFER/);
  assert.match(grokui, /function isDoneReply/);
  assert.match(grokui, /function isTransientModelFail/);
  assert.match(grokui, /function enqueueAutoHop/);
  assert.match(grokui, /function shouldKeepAuto/);
  assert.match(grokui, /RACE_EVERY_FAILED/);
  assert.match(grokui, /kickTurn\(threadId, userText, onEvent\)/);
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
  const brace = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(brace, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

test('grokui-app depends on openzoo latest, not a 0.48 caret', () => {
  assert.equal(appPkg.dependencies.openzoo, 'latest');
  const lock = require('../grokui-app/package-lock.json');
  assert.equal(lock.packages[''].dependencies.openzoo, 'latest');
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
  const scriptStart = grokui.indexOf('<script>');
  const scriptEnd = grokui.indexOf('</script>', scriptStart);
  const script = grokui.slice(scriptStart, scriptEnd);
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
  const scriptStart = grokui.indexOf('<script>');
  const scriptEnd = grokui.indexOf('</script>', scriptStart);
  const script = grokui.slice(scriptStart, scriptEnd);
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
  const bundle = readFileSync(path.join(root, 'grokui-app', 'scripts', 'bundle-grokui.js'), 'utf8');
  assert.match(bundle, /livestatus\.js/);
  assert.match(bundle, /racesettle\.js/);
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

test('grokui chat does not dump raw 0x6a wrap simulation logs', () => {
  const brain = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');
  assert.match(brain, /function sanitizeProxiedError/);
  assert.match(brain, /wrap ix has too few accounts \(need 9\)/);
  assert.match(brain, /sanitizeProxiedError\(j\?\.error\?\.message\)/);
});

test('ensureProxy reuses a healthy :8402 and does not spawn over it', () => {
  assert.match(main, /function portOccupied/);
  assert.match(main, /Reuse only a healthy :8402/);
  // Occupied-port + hung session is NOT reuse — ping must time out.
  assert.match(main, /not reusing a wedged proxy/);
  assert.match(main, /Ping must time out/);
  // Occupied+healthy is not enough: compare listener version to shipped openzoo.
  assert.doesNotMatch(main, /if \(await pingUrl\('http:\/\/127\.0\.0\.1:8402\/v1\/session'\)\) return/);
  assert.match(main, /sidecarIsAttachable\(\{ listenerVersion, expectedVersion \}\)/);
  assert.match(main, /function expectedOpenzooVersion/);
  assert.match(main, /path\.join\(__dirname, '\.\.', 'package\.json'\)/);
  assert.match(main, /path\.join\(__dirname, 'node_modules', 'openzoo', 'package\.json'\)/);
  assert.match(main, /expected\/shipped version/);
  assert.match(main, /stale sidecar/);
  assert.match(main, /not attaching; grokui will spawn the matching one/);
  assert.match(main, /refusing to attach/);
  assert.match(main, /displaceStaleListener/);
  assert.match(main, /spawn\(process\.execPath, \[bin\]/);
  assert.match(main, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(main, /node_modules', 'openzoo', 'bin', 'openzoo\.js'/);
  assert.doesNotMatch(main, /npx openzoo@latest/);
  const proxy = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  const session = proxy.slice(proxy.indexOf("=== '/v1/session'"), proxy.indexOf("=== '/v1/wallet'"));
  assert.match(session, /version,/);
});

test('cut and release scripts keep openzoo latest or refuse', () => {
  const cut = readFileSync(path.join(root, 'scripts', 'cut-grokui.mjs'), 'utf8');
  const rel = readFileSync(path.join(root, 'scripts', 'release-mac.sh'), 'utf8');
  assert.match(cut, /dependencies\.openzoo = 'latest'/);
  assert.match(cut, /refuse to cut/);
  assert.match(rel, /assert-grokui-pin/);
  const { spawnSync } = require('node:child_process');
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

