import assert from 'node:assert/strict';
import test from 'node:test';
import {
  grokBotQuitPlan,
  inspectGrokBotHijack,
  grokBotLaunchEnv,
  wantsBotDaemon,
  isBotDaemonChild,
} from '../lib/grokcli.js';
import { looksStoppedReply } from '../lib/cursorbackend.js';
import { killListen } from '../lib/proxy.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('killListen kills other pids on the port, not us', () => {
  const ran = [];
  const run = (cmd) => {
    ran.push(cmd);
    if (String(cmd).startsWith('lsof')) return `111\n${process.pid}\n222\n`;
    return '';
  };
  const pids = killListen(8402, run);
  assert.deepEqual(pids, [111, 222]);
  assert.ok(ran.some((c) => c === 'kill 111'));
  assert.ok(ran.some((c) => c === 'kill 222'));
  assert.ok(!ran.some((c) => c === `kill ${process.pid}`));
});

test('startProxy bounces a listener instead of reusing it', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/proxy.js'), 'utf8');
  assert.match(src, /killed proxy on/);
  assert.match(src, /killListen\(config\.port\)/);
  assert.match(src, /export async function oursOn/);
  assert.doesNotMatch(src, /config\.port \+= 1/);
  assert.doesNotMatch(src, /trying :\${config\.port}/);
  assert.doesNotMatch(src, /reused: true/);
  const bot = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/grokcli.js'), 'utf8');
  assert.match(bot, /starting proxy on/);
  assert.match(bot, /killListen\(port\)/);
  assert.doesNotMatch(bot, /8443 already bound — reusing it/);
  assert.doesNotMatch(bot, /if \(!up\) \{\s*console\.error\('openzoo: starting proxy/);
});

test('every subcommand steals stale :8402 instead of hopping', () => {
  const read = (f) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');
  const setup = read('lib/setup.js');
  assert.match(setup, /oursOn\(config\.port\)/);
  assert.match(setup, /stale proxy — stealing/);
  const aoe = read('lib/aoe.js');
  assert.match(aoe, /oursOn\(config\.port\)/);
  assert.match(aoe, /stale proxy on/);
  const launch = read('lib/launch.js');
  assert.match(launch, /oursOn\(config\.port\)/);
  assert.doesNotMatch(launch, /heal onto a different port/);
  const zoo = read('bin/claude-zoo.js');
  assert.match(zoo, /stealing for v/);
});

test('quit plan: reboot login-item without hijack env gets bounced', () => {
  const p = grokBotQuitPlan({ running: true, hijacked: false });
  assert.equal(p.quit, true);
  assert.equal(p.spawn, true);
  assert.match(p.reason, /login item|hijack env/);
});

test('quit plan: already-hijacked session is left alone', () => {
  const p = grokBotQuitPlan({ running: true, hijacked: true });
  assert.equal(p.quit, false);
  assert.equal(p.spawn, false);
});

test('quit plan: hijacked without spend-chip debug port is bounced', () => {
  const p = grokBotQuitPlan({ running: true, hijacked: true, chipDebug: false });
  assert.equal(p.quit, true);
  assert.equal(p.spawn, true);
  assert.match(p.reason, /spend-chip|debug port/);
});

test('quit plan: hijacked with spend-chip debug port is left alone', () => {
  const p = grokBotQuitPlan({ running: true, hijacked: true, chipDebug: true });
  assert.equal(p.quit, false);
  assert.equal(p.spawn, false);
});

test('quit plan: not running just spawns', () => {
  const p = grokBotQuitPlan({ running: false, hijacked: false });
  assert.equal(p.quit, false);
  assert.equal(p.spawn, true);
});

test('quit plan: --quit always bounces', () => {
  const p = grokBotQuitPlan({ forceQuit: true, running: true, hijacked: true });
  assert.equal(p.quit, true);
  assert.equal(p.spawn, true);
});

test('quit plan: --no-quit never bounces even after reboot', () => {
  const p = grokBotQuitPlan({ neverQuit: true, running: true, hijacked: false });
  assert.equal(p.quit, false);
  assert.equal(p.spawn, true);
});

test('inspect: env on the pid counts as hijacked', () => {
  const url = 'https://127.0.0.1:8443';
  const run = (cmd) => {
    if (cmd.startsWith('pgrep')) return '4242\n';
    if (cmd.includes('ps')) return `Grok Bot CURSOR_API_BASE_URL=${url} rest`;
    throw new Error('no lsof');
  };
  const s = inspectGrokBotHijack(url, 8443, run);
  assert.equal(s.running, true);
  assert.deepEqual(s.pids, ['4242']);
  assert.equal(s.hijacked, true);
  assert.equal(s.chipDebug, false);
});

test('openzoo bot does not respawn Grok Bot on a timer', () => {
  const cli = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib/grokcli.js'), 'utf8');
  assert.doesNotMatch(cli, /relaunching for the spend chip/);
  assert.match(cli, /launchGrokBot/);
  assert.match(cli, /delayMs: plan.spawn \? 8000 : 2000/);
});

test('wantsBotDaemon is opt-in and skipped in the child', () => {
  assert.equal(wantsBotDaemon(['--daemon']), true);
  assert.equal(wantsBotDaemon(['-d']), true);
  assert.equal(wantsBotDaemon([]), false);
  assert.equal(wantsBotDaemon(['--daemon', '--once']), false);
  assert.equal(wantsBotDaemon(['--daemon'], { OPENZOO_BOT_DAEMON_CHILD: '1' }), false);
  assert.equal(isBotDaemonChild({ OPENZOO_BOT_DAEMON_CHILD: '1' }), true);
});

test('grokBotLaunchEnv strips Electron-as-node so Grok Bot can open a window', () => {
  const env = grokBotLaunchEnv('https://127.0.0.1:8443', {
    ELECTRON_RUN_AS_NODE: '1',
    APPIMAGE: '/tmp/OpenZoo-Bot.AppImage',
    APPDIR: '/tmp/squashfs',
    LD_LIBRARY_PATH: '/tmp/squashfs/usr/lib',
    PATH: '/usr/bin',
    HOME: '/home/u',
  });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.APPIMAGE, undefined);
  assert.equal(env.APPDIR, undefined);
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.CURSOR_API_BASE_URL, 'https://127.0.0.1:8443');
  assert.equal(env.SAND_HOST_GATEWAY_URL, 'https://127.0.0.1:8443');
  assert.equal(env.PATH, '/usr/bin');
});

test('OpenZoo Bot wrapper launches the sidecar with --daemon', () => {
  const main = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokbot-app/main.js'), 'utf8');
  assert.match(main, /bot', '--daemon'/);
  assert.match(main, /sidecar daemonized/);
});

test('inspect: remote-debugging-port on the pid counts as chipDebug', () => {
  const url = 'https://127.0.0.1:8443';
  const run = (cmd) => {
    if (cmd.startsWith('pgrep')) return '4242\n';
    if (cmd.includes('ps')) return `Grok Bot CURSOR_API_BASE_URL=${url} --remote-debugging-port=9444 rest`;
    throw new Error('no lsof');
  };
  const s = inspectGrokBotHijack(url, 8443, run);
  assert.equal(s.hijacked, true);
  assert.equal(s.chipDebug, true);
});

test('inspect: login-item with no env and no 8443 conn is not hijacked', () => {
  const run = (cmd) => {
    if (cmd.startsWith('pgrep')) return '99\n';
    if (cmd.includes('ps')) return 'Grok Bot';
    throw new Error('lsof empty');
  };
  const s = inspectGrokBotHijack('https://127.0.0.1:8443', 8443, run);
  assert.equal(s.running, true);
  assert.equal(s.hijacked, false);
});

test('looksStoppedReply matches the measured park phrases', () => {
  assert.equal(looksStoppedReply('Stopped on research. No app files written this turn — ~/fee-sus/static is still empty.'), true);
  assert.equal(looksStoppedReply('Stopped on research — no new app files written.'), true);
  assert.equal(looksStoppedReply('Nothing extra to open yet. Say go again if you want ~/fee-sus written'), true);
  assert.equal(looksStoppedReply('Next message I’ll write ~/fee-sus'), true);
  assert.equal(looksStoppedReply('wrote /Users/stacc/fee-sus/index.html and it is ready to open'), false);
});
