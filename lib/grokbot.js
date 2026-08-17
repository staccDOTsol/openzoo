// `npx openzoo grokbot` — keep Grok Bot's UI, serve OUR box underneath.
//
// Grok Bot is a thin client over Cursor's aiserver.v1 API. Each bot gets a
// pod from `GrokBotService/EnsureSandBox` — a cursorvm.com VM the agent runs
// in. We MITM api2.cursor.sh (proven: /etc/hosts pin + Node TLS override lets
// us answer 88 methods and passthrough the rest with real bodies), and for
// that ONE method we return OUR RunPod box in Cursor's exact 12-field wire
// shape. The polished UI is theirs; the sandbox is ours.
//
// THE WALL, STATED HONESTLY: once the app has our pod, it speaks Cursor's
// in-pod agent protocol to port 1337 and expects a VNC/websockify desktop on
// 6080. We do not yet speak either. The box therefore runs lib/podagent.mjs,
// which LOGS every request on those ports to /var/log/openzoo/agent.jsonl. So
// this ships as a CAPTURE hijack: the UI connects to our box, and we read what
// it sends to learn the protocol we then have to implement. That is the honest
// state — a working hijack needs that protocol, and this is how we get it.

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { config, USDC_MINT, TOKEN_MINT } from './config.js';
import { PayClient } from './pay.js';
import {
  podEndpoints, readyBox, runpodConfigured, spawnBox, listBoxes, execInBox,
} from './boxes.js';

const APP = '/Applications/Grok Bot.app';
const GROK_HOME = process.env.GROK_HOME || join(homedir(), '.grok');

export async function runGrokBot(argv = []) {
  if (process.platform !== 'darwin') {
    console.error('openzoo grokbot: the app hijack is macOS-only (needs Grok Bot.app + /etc/hosts).');
    process.exit(1);
  }
  if (!existsSync(APP)) {
    console.error('openzoo grokbot: /Applications/Grok Bot.app not found.');
    process.exit(1);
  }
  if (!runpodConfigured()) {
    console.error('openzoo grokbot: RUNPOD_API_KEY not set (needs an rpa_… key).');
    console.error('  export RUNPOD_API_KEY=rpa_…   then re-run. Boxes bill to that account;');
    console.error('  inference bills per-call to the box\'s own openzoo wallet.');
    process.exit(1);
  }

  const days = Number((argv.find((a) => /^--days=/.test(a)) || '').split('=')[1]) || 1;

  // 1) a box, ready, BEFORE we touch the app — so the first EnsureSandBox we
  //    hijack already has a live pod to point at. The box mints its OWN wallet
  //    (never the operator's secret key — that never leaves this Mac). There is
  //    NO --task and NO --share-wallet: the task is whatever the user types
  //    into the Grok Bot UI, captured from the MITM'd chat request and driven
  //    through to the box over POST /drive.
  console.error('openzoo grokbot: spawning your box (CPU, x402-funded)…');
  const spawned = await spawnBox({ name: 'grokbot', days });
  if (!spawned.ok) { console.error(`  spawn failed: ${spawned.error}`); process.exit(1); }
  const box = spawned.box;
  console.error(`  ${box.name}  ${box.id}  expires ${spawned.expiresAt.slice(0, 16)}`);
  const ready = await readyBox(box.id, { log: (m) => console.error(m) });
  if (!ready.ok) console.error(`  ${ready.error} — continuing; the capture agent may still bind`);
  else console.error(`  box ready in ${ready.seconds}s`);

  // the box minted its OWN wallet on boot — print its funding address so it
  // can be topped up directly. Its brain pays per call from THIS wallet, not
  // the operator's; a fresh box starts at $0 until funded.
  if (box.ssh) {
    const addr = await execInBox(box, 'npx --yes openzoo address 2>/dev/null');
    if (addr.ok && addr.stdout.trim()) {
      console.error('  box wallet (top up to give it inference budget):');
      console.error(addr.stdout.trim().split('\n').map((l) => `    ${l}`).join('\n'));
    }
    console.error(`  mints: USDC ${USDC_MINT} · TOKEN ${TOKEN_MINT} (Solana)`);
  }

  const ep = podEndpoints(box.id);
  process.env.OZ_HIJACK_POD = JSON.stringify({
    region: 'us1',
    accountId: box.id.replace(/[^a-z0-9]/gi, '').slice(0, 20),
    podId: `pod-${box.id}`,
    token: `nto-${Math.random().toString(36).slice(2, 12)}`,
    agent: ep.agent, vnc: ep.vnc, p1340: ep.p1340, p6081: ep.p6081,
  });
  // the backend (handleStreamChat) forwards each UI prompt here to be driven
  process.env.OZ_BOX_AGENT = ep.agent;
  // other methods must still reach the REAL backend, or the app can't load
  process.env.OPENZOO_PASSTHRU = '1';
  process.env.OPENZOO_FORCE_BLOCK = '1';

  // 2) pin + serve api2.cursor.sh locally (sudo). Chromium flags don't reach
  //    the Electron main process; only /etc/hosts + Node TLS override do.
  const { blockBackend, unblockBackend, isBlocked } = await import('./hosts.js');
  const { startCursorBackend } = await import('./cursorbackend.js');
  console.error('openzoo grokbot: pinning api2.cursor.sh (sudo)…');
  if (!isBlocked()) blockBackend();
  startCursorBackend({ port: 443, log: (m) => console.error(`  backend: ${m}`) });

  const restore = () => { try { unblockBackend(); console.error('openzoo: /etc/hosts restored.'); } catch { /* */ } };
  process.on('SIGINT', () => { restore(); process.exit(0); });
  process.on('exit', restore);

  // 3) launch the app directly (open -a can't pass env) with Node TLS override
  console.error('openzoo grokbot: launching Grok Bot pointed at your box…');
  console.error(`  box proxy   : ${ep.proxy}`);
  console.error(`  agent (1337): ${ep.agent}`);
  console.error(`  ssh         : ${box.ssh || '(pending)'}`);
  console.error('  WATCH the box agent log for what the app sends:');
  console.error(`    ${box.ssh ? box.ssh + " 'tail -f /var/log/openzoo/agent.log'" : '(ssh not ready yet)'}`);
  try { execSync('osascript -e \'tell application "Grok Bot" to quit\'', { stdio: 'ignore' }); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 2500));
  spawn(`${APP}/Contents/MacOS/Grok Bot`, ['--ignore-certificate-errors'], {
    stdio: 'ignore', detached: true,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  }).unref();

  console.error('openzoo grokbot: ctrl-c to stop, restore /etc/hosts, and leave the box running.');
  console.error(`  the box keeps running until its TTL — manage with: RUNPOD_API_KEY=… openzoo grokbot (again) or the runpod console`);
  await new Promise(() => {});
}
