// RunPod CPU boxes — the sandbox fleet `openzoo grokbot` runs its agents in.
//
// SAME SHAPE AS GROK BOT, DIFFERENT ECONOMICS. Grok Bot provisions a
// cursorvm.com pod per bot and runs the agent inside Cursor's cloud, billing
// through them (MEASURED: EnsureSandBox returns
// `<id>-pod-<id>-1337.us9.cursorvm.com` + a VNC port + /workspace/terminals).
// This does the same thing on RunPod, with inference paid per-call by x402
// from a wallet the box holds — no account, no provider key.
//
// CPU ONLY, ALWAYS. A GPU flavour here would be a silent 100x on the bill for
// a box that only ever runs a shell and a node process. `spawnBox` builds its
// request body without GPU fields AND asserts on the serialized JSON, because
// an `in` check against a literal you wrote three lines earlier can never fail
// — that guard is decoration, not enforcement.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
let _agentB64 = null;
function podAgentB64() {
  if (_agentB64) return _agentB64;
  const here = dirname(fileURLToPath(import.meta.url));
  _agentB64 = readFileSync(join(here, 'podagent.mjs')).toString('base64');
  return _agentB64;
}

const REST = 'https://rest.runpod.io/v1';
export const BOX_PREFIX = 'openzoo-box-';
const CPU_FLAVORS = ['cpu3c', 'cpu3g', 'cpu5c'];
// GLIBC, NOT ALPINE. `npx openzoo` pulls native deps (ed25519 / ws helpers);
// on musl they fail to build because the entrypoint has no toolchain, which is
// why alpine boxes sat at 404 forever. Debian-slim runs the shim as published,
// and its apt has a real sshd.
// Everything the box runs is ALREADY IN THE IMAGE: the shim, its node_modules,
// grokui, and sshd. Boxes used to apt-get and `npx openzoo` at boot, which put
// a package fetch on the critical path from RunPod egress IPs — and those get
// rate limited. A 429 from raw.githubusercontent arrives as a FILE whose
// contents are the text "429: Too Many Requests", so node ran it and failed in
// a way that read as an app bug rather than a download bug.
// Still glibc, never musl: @solana's native deps don't build on the box.
const BOX_IMAGE = process.env.OPENZOO_BOX_IMAGE || 'jrsdunn123/openzoo-box:latest';
const BOX_PORTS = ['8402/http', '4173/http', '1337/http', '6080/http', '1340/http', '6081/http', '22/tcp'];
const TTL_MAX_HOURS = 90 * 24;

/**
 * Boot: write the wallet, START SSHD, start the x402 proxy + capture agent.
 *
 * SSHD IS NOT OPTIONAL and was the second bug: our dockerStartCmd replaces the
 * image's own init, so nothing starts sshd and every `execInBox` got
 * "connection refused" — the agent had no hands. RunPod injects the account
 * key at $PUBLIC_KEY / $SSH_PUBLIC_KEY; we write it to authorized_keys, generate
 * host keys, and run sshd in the foreground of the background. Passwordless
 * root login is NOT enabled — key-only.
 *
 * NOTHING IS FETCHED AT BOOT. sshd, the shim and grokui are baked into
 * BOX_IMAGE by box.Dockerfile; this only copies /opt into the volume RunPod
 * mounts over /workspace and starts things. readyBox() still polls /v1/models
 * rather than assuming a timing.
 */
const ENTRYPOINT = [
  'bash', '-lc',
  'set +e; mkdir -p /workspace /root/.openzoo /var/log/openzoo /run/sshd /root/.ssh; '
  + 'if [ -n "$OPENZOO_WALLET_JSON" ]; then printf %s "$OPENZOO_WALLET_JSON" > /root/.openzoo/wallet.json; chmod 600 /root/.openzoo/wallet.json; fi; '
  // RunPod hands the operator pubkey in one of these — accept whichever is set
  + 'for K in "$PUBLIC_KEY" "$SSH_PUBLIC_KEY"; do [ -n "$K" ] && echo "$K" >> /root/.ssh/authorized_keys; done; chmod 600 /root/.ssh/authorized_keys 2>/dev/null; '
  + 'ssh-keygen -A >/dev/null 2>&1; sed -i "s/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/" /etc/ssh/sshd_config 2>/dev/null; /usr/sbin/sshd -e >/var/log/openzoo/sshd.log 2>&1 & '
  // RUN FROM /opt, never from /workspace. Staging the app onto the volume and
  // gating on `[ ! -f .../bin/openzoo.js ]` is a trap: one interrupted copy
  // leaves that file behind, every later boot skips the copy, and the box
  // crash-loops on a half-copied node_modules forever (seen in production as
  // "Cannot find module .../viem/accounts" every 15s, which also cost the pod
  // its HTTP port mappings). The app is read-only at runtime; mutable state
  // lives in /root/.openzoo.
  + 'until OPENZOO_BIND=0.0.0.0 node /opt/openzoo/bin/openzoo.js >> /var/log/openzoo/proxy.log 2>&1; do echo "proxy exited, restarting" >> /var/log/openzoo/proxy.log; sleep 2; done & '
  + 'until OZ_GROKUI_BIND=0.0.0.0 OZ_GROKUI_PORT=4173 node /opt/grokui/grokui.mjs >> /var/log/openzoo/grokui.log 2>&1; do echo "grokui exited, restarting" >> /var/log/openzoo/grokui.log; sleep 2; done & '
  // the capture agent answers the ports Grok Bot expects a Cursor sandbox on,
  // logging the protocol we do not yet speak (see lib/podagent.mjs)
  + 'if [ -n "$OZ_PODAGENT_B64" ]; then printf %s "$OZ_PODAGENT_B64" | base64 -d > /opt/podagent.mjs; node /opt/podagent.mjs > /var/log/openzoo/agent.log 2>&1 & fi; '
  + 'sleep infinity',
];

function key() {
  const k = process.env.RUNPOD_API_KEY || '';
  return typeof k === 'string' ? k.trim() : '';
}

export function runpodConfigured() {
  // guard the access, not just the prefix — an unset key must not throw here
  return key().startsWith('rpa_');
}

async function rp(path, init) {
  const k = key();
  if (!k) return { ok: false, status: 503, data: { error: 'RUNPOD_API_KEY not set' } };
  const res = await fetch(`${REST}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function ttlHours(days = 30) {
  return Math.min(Math.max(Number(days) || 30, 1) * 24, TTL_MAX_HOURS);
}

/**
 * Expiry is encoded in the name so a box is reapable even if its env is lost.
 *
 * PARSED FROM A FIXED POSITION, NOT `.pop()`. The name ends
 * `-<unix>-<rand4>`, so popping the last segment yields the RANDOM suffix,
 * Number() gives NaN, and every box reports "no expiry" — which is exactly the
 * bug the site's copy of this had.
 */
export function expiresFromName(name) {
  if (!name?.startsWith(BOX_PREFIX)) return null;
  const parts = name.split('-');
  const n = Number(parts[parts.length - 2]);
  return Number.isFinite(n) && n > 1_700_000_000 ? n : null;
}

export function proxyUrl(id, port = 8402) {
  return id ? `https://${id}-${port}.proxy.runpod.net` : null;
}

/** The URLs Grok Bot's EnsureSandBox response needs, all fronted by RunPod. */
export function podEndpoints(id) {
  return id ? {
    agent: proxyUrl(id, 1337),
    vnc: proxyUrl(id, 6080),
    p1340: proxyUrl(id, 1340),
    p6081: proxyUrl(id, 6081),
    proxy: proxyUrl(id, 8402),
  } : null;
}

/** What a caller may see. NEVER the raw pod: `env` carries OPENZOO_WALLET_JSON,
 *  which is a funded private key. Raw pods must not escape this module. */
export function serializeBox(p) {
  const exp = expiresFromName(p.name) || Number(p.env?.OPENZOO_EXPIRES_UNIX || 0) || null;
  const sshPort = p.portMappings?.['22'];
  return {
    id: p.id,
    name: p.name,
    status: p.desiredStatus,
    costPerHr: p.costPerHr,
    proxy: proxyUrl(p.id),
    ssh: p.publicIp && sshPort ? `ssh -o StrictHostKeyChecking=no root@${p.publicIp} -p ${sshPort}` : null,
    host: p.publicIp || null,
    sshPort: sshPort || null,
    console: p.id ? `https://www.runpod.io/console/pods/${p.id}` : null,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
  };
}

/** Our boxes only, serialized. */
export async function listBoxes() {
  const r = await rp('/pods');
  if (!Array.isArray(r.data)) return { ok: false, error: r.data?.error || `pods ${r.status}`, boxes: [] };
  return {
    ok: true,
    boxes: r.data.filter((p) => !p.gpuCount && p.name?.startsWith(BOX_PREFIX)).map(serializeBox),
  };
}

export async function killBox(id) {
  return rp(`/pods/${id}`, { method: 'DELETE' });
}

/** Delete our boxes past their deadline. Name-prefix scoped AND gpu-guarded. */
export async function reapExpired() {
  const r = await rp('/pods');
  if (!Array.isArray(r.data)) return { reaped: [] };
  const now = Math.floor(Date.now() / 1000);
  const reaped = [];
  for (const p of r.data) {
    if (!p.id || p.gpuCount || !p.name?.startsWith(BOX_PREFIX)) continue;
    const deadline = expiresFromName(p.name) || Number(p.env?.OPENZOO_EXPIRES_UNIX || 0);
    if (deadline && now >= deadline) {
      await killBox(p.id);
      reaped.push(p.id);
    }
  }
  return { reaped };
}

/**
 * MACHINE TIERS — a menu, not one size.
 *
 * A box that only runs a shell is fine on 2 vCPU, but a grokbot agent that
 * builds a site, runs a dev server, or compiles wants real muscle — and some
 * tasks want a GPU. So the orchestrator quotes SEVERAL tiers per timeframe and
 * the user picks. GPU is a DELIBERATE tier here, never an accident: the guard
 * below refuses GPU fields on a CPU tier, so a cpu tier can't silently 100x the
 * bill, while a gpu tier carries them on purpose.
 *
 * $/hr are approximate RunPod secure-cloud rates for sizing the quote; the real
 * charge is whatever RunPod bills. estUsdHr is labelled approximate for that.
 */
export const BOX_TIERS = {
  'cpu-sm':  { label: 'CPU · 2 vCPU',       compute: 'CPU', vcpu: 2, disk: 20,  estUsdHr: 0.06 },
  'cpu-md':  { label: 'CPU · 4 vCPU',       compute: 'CPU', vcpu: 4, disk: 40,  estUsdHr: 0.12 },
  'cpu-lg':  { label: 'CPU · 8 vCPU',       compute: 'CPU', vcpu: 8, disk: 60,  estUsdHr: 0.24 },
  'gpu-4090':{ label: 'GPU · 1× RTX 4090',  compute: 'GPU', gpuTypeIds: ['NVIDIA GeForce RTX 4090'], gpuCount: 1, disk: 60,  estUsdHr: 0.44 },
  'gpu-a100':{ label: 'GPU · 1× A100 80GB', compute: 'GPU', gpuTypeIds: ['NVIDIA A100 80GB PCIe'],   gpuCount: 1, disk: 80,  estUsdHr: 1.64 },
};
export const DEFAULT_TIER = 'cpu-sm';

/** The quote menu the orchestrator shows: every tier priced for `days`. */
export function quoteTiers(days = 1) {
  const hrs = ttlHours(days);
  return Object.entries(BOX_TIERS).map(([key, t]) => ({
    tier: key, label: t.label, days: Math.round(hrs / 24 * 10) / 10,
    estUsd: Math.round(t.estUsdHr * hrs * 100) / 100, estUsdHr: t.estUsdHr, gpu: t.compute === 'GPU',
  }));
}

export async function spawnBox({ name = 'bot', days = 1, tier = DEFAULT_TIER, walletJson, pubkey, task } = {}) {
  const spec = BOX_TIERS[tier] || BOX_TIERS[DEFAULT_TIER];
  const expiresAt = new Date(Date.now() + ttlHours(days) * 3600 * 1000);
  const unix = Math.floor(expiresAt.getTime() / 1000);
  const rand = Math.random().toString(36).slice(2, 6);
  const full = `${BOX_PREFIX}${name}-${unix}-${rand}`;

  const body = {
    name: full,
    computeType: spec.compute,
    cloudType: 'SECURE',
    imageName: BOX_IMAGE,
    containerDiskInGb: spec.disk,
    volumeInGb: 10,
    volumeMountPath: '/workspace',
    ports: BOX_PORTS,
    dockerStartCmd: ENTRYPOINT,
    ...(spec.compute === 'CPU'
      ? { vcpuCount: spec.vcpu, cpuFlavorIds: CPU_FLAVORS, cpuFlavorPriority: 'availability' }
      : { gpuCount: spec.gpuCount, gpuTypeIds: spec.gpuTypeIds }),
    env: {
      OPENZOO_BOX: '1',
      OPENZOO_TIER: tier,
      OPENZOO_EXPIRES_UNIX: String(unix),
      OPENZOO_NO_TUNNEL: '1',           // the runpod proxy already fronts it
      OPENZOO_BIND: '0.0.0.0',          // else the runpod proxy can't reach :8402
      OPENZOO_TUNNEL_TOKEN: `oz-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
      ...(walletJson ? { OPENZOO_WALLET_JSON: walletJson } : {}),
      ...(pubkey ? { OPENZOO_WALLET_PUBKEY: pubkey } : {}),
      OZ_PODAGENT_B64: podAgentB64(),
      ...(task ? { OZ_TASK: task } : {}),
    },
  };
  // GPU ONLY ON A GPU TIER. A cpu tier must never carry GPU fields — that would
  // be a silent 100x. Enforced on the serialized payload, not a literal.
  const wire = JSON.stringify(body);
  if (spec.compute === 'CPU' && /"gpu(Count|TypeIds)"/.test(wire)) {
    throw new Error('refusing to spawn: GPU fields on a CPU tier');
  }

  const created = await rp('/pods', { method: 'POST', body: wire });
  if (!created.ok) return { ok: false, error: created.data?.error || `spawn ${created.status}` };
  return { ok: true, tier, box: serializeBox(created.data), expiresAt: expiresAt.toISOString() };
}

/** Poll until the box answers on its proxy — npx has to fetch the shim first. */
export async function readyBox(id, { timeoutMs = 240_000, log = () => {} } = {}) {
  const url = `${proxyUrl(id)}/v1/models`;
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) return { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
      last = `http ${r.status}`;
    } catch (e) { last = e.name === 'TimeoutError' ? 'timeout' : e.message; }
    log(`  waiting for box proxy… (${Math.round((Date.now() - started) / 1000)}s, ${last})`);
    await new Promise((r) => setTimeout(r, 6000));
  }
  return { ok: false, error: `box proxy never came up (${last})` };
}

/** Run a command INSIDE the box. This is the sandbox half of the product:
 *  the model runs wherever openzoo routes it, the side effects land here. */
export async function execInBox(box, cmd, { timeoutMs = 120_000 } = {}) {
  if (!box.host || !box.sshPort) return { ok: false, stdout: '', stderr: 'box has no ssh yet' };
  try {
    const { stdout, stderr } = await pexec('ssh', [
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=15',
      '-p', String(box.sshPort), `root@${box.host}`, cmd,
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}
