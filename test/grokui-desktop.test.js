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
  assert.match(grokui, /value="grok4.6"/);
  assert.match(grokui, />grok 4.6</);
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
  assert.match(grokui, /const AUTO_RACE_RETRY/);
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

test('openzoo and grokui-app versions bump together', () => {
  assert.equal(ozPkg.version, '0.49.1');
  assert.equal(appPkg.version, '1.5.79');
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
  assert.match(grokui, /function kickTurn/);
  assert.match(grokui, /emitToThread\(threadId, ev\)/);
  const brain = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');
  assert.match(brain, /createRaceFeed/);
  assert.match(brain, /classifyRaceAnswer/);
  assert.match(brain, /raceLastShip/);
  assert.doesNotMatch(brain, /if \(!cands\.length\) return '';/);
  assert.doesNotMatch(brain, /Streaming is deliberately not forwarded/);
  const live = readFileSync(path.join(root, 'lib', 'livestatus.js'), 'utf8');
  assert.match(live, /racing \$\{b\}\/\$\{n\} back/);
  assert.match(live, /RACE_EVERY_FAILED/);
  assert.match(live, /fetch failed/);
  const bundle = readFileSync(path.join(root, 'grokui-app', 'scripts', 'bundle-grokui.js'), 'utf8');
  assert.match(bundle, /livestatus\.js/);
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
  assert.match(main, /Reuse only a healthy :8402/);
  assert.match(main, /if \(await pingUrl\('http:\/\/127\.0\.0\.1:8402\/v1\/session'\)\) return/);
  // Occupied-port + hung session is NOT reuse — ping must time out.
  assert.match(main, /not reusing a wedged proxy/);
  assert.match(main, /Ping must time out/);
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

