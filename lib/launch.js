/**
 * `npx openzoo claude [args...]` — launch Claude Code (or any Anthropic-shaped
 * harness) already pointed at the local zoo, so its inference is paid per turn
 * over x402 instead of hitting Anthropic directly.
 *
 * This is the supported front door: ANTHROPIC_BASE_URL is an official env var
 * Claude Code reads at startup. No DNS games, no TLS interception — the proxy
 * serves POST /v1/messages (see lib/anthropic.js) and this just spawns the
 * harness with the two env vars set. The proxy must already be running
 * (`npx openzoo` in another terminal); we check first and say so if not.
 */
import { spawn } from 'node:child_process';
import { config } from './config.js';

export async function launchHarness(cmd, args) {
  const base = `http://localhost:${config.port}/v1`;
  // Fail early with a clear message rather than letting the harness spew
  // connection errors — the #1 support question would otherwise be "why won't
  // claude connect" when the answer is "the proxy isn't up".
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    console.error(`openzoo: no proxy reachable at ${base}`);
    console.error('start it first in another terminal:  npx openzoo');
    process.exit(1);
  }

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'sk-openzoo',
    // Claude Code sends model ids like "claude-opus-5"; the zoo serves those,
    // and unknown ids are matched to the nearest served model regardless.
  };
  console.error(`openzoo: launching \`${cmd}\` on the zoo (ANTHROPIC_BASE_URL=${base}) — every turn pays x402`);
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(`openzoo: could not launch \`${cmd}\`: ${e.message}`);
    process.exit(1);
  });
}
