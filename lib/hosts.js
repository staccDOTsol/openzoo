/**
 * Force the editor off its own backend by blackholing it in /etc/hosts.
 *
 * WHY THIS IS NEEDED: Cursor renders its model picker from IN-MEMORY state that
 * it re-syncs from `api2.cursor.sh` on window focus. Writing the database is not
 * enough — measured, the DB held 413 openzoo models and the correct selection
 * while the UI showed none, because the sync repainted memory a moment later.
 * The same host is `bcProxyUrl`, the route Cursor's own inference takes, so
 * while it is reachable the editor will always prefer it over a custom endpoint.
 *
 * Pointing it at 127.0.0.1 makes that path fail, leaving the configured OpenAI
 * base URL as the only way out.
 *
 * COLLATERAL, STATED PLAINLY: that host also carries auth and usage reporting.
 * The editor may report being signed out or degraded. This is a system-wide
 * change needing a password, so it always backs up the hosts file first and
 * `npx openzoo unblock` restores it. `--no-block` skips it entirely.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Hosts-file location and the privilege/flush mechanics differ per platform:
 *   macOS   /etc/hosts          sudo   + dscacheutil/mDNSResponder
 *   Linux   /etc/hosts          sudo   + systemd-resolve or nscd (best effort)
 *   Windows %SystemRoot%\\System32\\drivers\\etc\\hosts, needs an ELEVATED shell
 * Everything below branches on that rather than assuming macOS.
 */
const WIN = process.platform === 'win32';
const HOSTS = WIN
  ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\drivers\\etc\\hosts`
  : '/etc/hosts';
const BACKUP = `${HOSTS}.openzoo-backup`;
const MARK = '# openzoo: force the editor onto the local proxy';

/**
 * The DEFAULT block — the model-list re-sync host only. Blocking this forces a
 * subscribed account's editor onto our model list + endpoint without severing
 * chat, so plain `openzoo cursor` works for subbed users.
 *
 * The chat-inference hosts (agent.api5.*) are NOT here: blocking them without a
 * working StreamUnifiedChat translator severs chat entirely ("Reconnecting...",
 * observed on a working ultra account). They live in AGENT_HOSTS, blocked only
 * under --takeover where the impersonation backend actually answers chat.
 */
export const BACKEND_HOSTS = ['api2.cursor.sh'];

// Claude DESKTOP inference host — impersonated + forwarded to the local proxy
// (Messages API is JSON; the proxy already translates + pays x402).
export const CLAUDE_HOSTS = ['api.anthropic.com', 'api-staging.anthropic.com'];

export const AGENT_HOSTS = [
  'agent.api5.cursor.sh', 'agentn.api5.cursor.sh',
  'agent-gcpp-uswest.api5.cursor.sh', 'agentn-gcpp-uswest.api5.cursor.sh',
  'agent-gcpp-eucentral.api5.cursor.sh', 'agentn-gcpp-eucentral.api5.cursor.sh',
  'agent-gcpp-apsoutheast.api5.cursor.sh', 'agentn-gcpp-apsoutheast.api5.cursor.sh',
];

/** Every host this tool ever adds — the set `unblock` is responsible for removing. */
const ALL_MANAGED = [...BACKEND_HOSTS, ...CLAUDE_HOSTS, ...AGENT_HOSTS];

/**
 * A HOST IS NOT BLOCKED UNTIL BOTH FAMILIES ARE. Writing only the A record leaves
 * the AAAA intact, and a dual-stack client (Claude desktop / Chromium, happy
 * eyeballs) will simply take the v6 route straight to the real backend. Measured:
 * with `127.0.0.1 api.anthropic.com` in place, `curl -6` still reached
 * 2607:6bc0::10 and the real API answered. Every entry is therefore written and
 * matched as a v4+v6 pair.
 */
const FAMILIES = ['127.0.0.1', '::1'];

const esc = (s) => s.replace(/[.:]/g, '\\$&');

/** Matches a hosts line pinning `h` to loopback in either family. */
function hostLineRe(h, ip) {
  const addr = ip ? esc(ip) : `(?:${FAMILIES.map(esc).join('|')})`;
  return new RegExp(`^\\s*${addr}\\s+${esc(h)}\\b`, 'm');
}

function readHosts() {
  try { return fs.readFileSync(HOSTS, 'utf8'); } catch { return ''; }
}

/**
 * True when EVERY host in `hosts` is pinned to loopback in BOTH families.
 * Defaulting to BACKEND_HOSTS was a latent bug: `openzoo claude --desktop`
 * blocks CLAUDE_HOSTS, so this returned false, and `unblock`'s
 * `if (!isBlocked()) return { already: true }` guard bailed out without ever
 * removing the api.anthropic.com lines it had just written.
 */
export function isBlocked(hosts = BACKEND_HOSTS) {
  const txt = readHosts();
  if (!txt) return false;
  return hosts.every((h) => FAMILIES.every((ip) => hostLineRe(h, ip).test(txt)));
}

/** True when ANY host this tool manages is still pinned — what `unblock` must test. */
export function isAnyBlocked() {
  const txt = readHosts();
  if (!txt) return false;
  return ALL_MANAGED.some((h) => hostLineRe(h).test(txt));
}

/**
 * Run a privileged command. On unix sudo prompts in the user's own terminal;
 * on Windows we cannot elevate from here, so we return false and the caller
 * prints the line to run in an Administrator shell.
 */
function privileged(unixLine) {
  if (WIN) return false;
  const r = spawnSync('sudo', ['sh', '-c', unixLine], { stdio: 'inherit' });
  return r.status === 0;
}

/** Flush the OS resolver cache, best effort, per platform. */
function flushDnsCmd() {
  if (process.platform === 'darwin') {
    return 'dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null; true';
  }
  // Linux: whichever of these exists; none is fatal.
  return 'resolvectl flush-caches 2>/dev/null || systemd-resolve --flush-caches 2>/dev/null'
    + ' || service nscd restart 2>/dev/null; true';
}

export function blockBackend(hosts = BACKEND_HOSTS) {
  // Add only the hosts NOT already present, so a prior api2-only block still gets
  // the agent/chat hosts appended (early-returning on isBlocked left them out).
  const current = readHosts();
  // A host counts as missing if EITHER family is absent, so a v4-only block
  // written by an older version gets its ::1 line added on the next run.
  const pairs = [];
  for (const h of hosts) {
    for (const ip of FAMILIES) {
      if (!hostLineRe(h, ip).test(current)) pairs.push(`${ip} ${h}`);
    }
  }
  if (!pairs.length) return { already: true };
  const entries = pairs.join('\\n');
  console.log('');
  console.log('blocking the editor\'s backend so it cannot re-sync over your model list.');
  console.log(`  hosts   : ${hosts.join(', ')} -> 127.0.0.1`);
  console.log(`  backup  : ${BACKUP}`);
  console.log('  NOTE    : that host also carries the editor\'s auth/usage — it may report');
  console.log('            being signed out. Undo any time with: npx openzoo unblock');
  console.log('            skip this next time with: --no-block');
  console.log('  sudo will ask for your password now.');
  if (WIN) {
    console.log('  windows: run this in an ADMINISTRATOR PowerShell, then relaunch:');
    console.log(`    Copy-Item "${HOSTS}" "${BACKUP}" -ErrorAction SilentlyContinue`);
    for (const h of hosts) console.log(`    Add-Content "${HOSTS}" "127.0.0.1 ${h}"`);
    console.log('    ipconfig /flushdns');
    return { ok: false, manual: true, blocked: false };
  }
  const ok = privileged(
    `cp -n ${HOSTS} ${BACKUP} 2>/dev/null; `
    + `printf '\\n${MARK}\\n${entries}\\n' >> ${HOSTS}; `
    + flushDnsCmd(),
  );
  return { ok, blocked: isBlocked() };
}

export function unblockBackend() {
  // Test EVERY managed host, not just BACKEND_HOSTS. `openzoo claude --desktop`
  // only ever blocks CLAUDE_HOSTS, so the old `isBlocked()` default reported
  // "nothing to do" and left 127.0.0.1 api.anthropic.com pinned forever — the
  // Claude desktop app then had no route to inference at all once the root
  // backend on :443 was gone.
  if (!isAnyBlocked()) return { already: true };
  // Remove only OUR lines, never restore wholesale — the user may have edited
  // /etc/hosts for unrelated reasons since the backup was taken.
  const pattern = ALL_MANAGED.map((h) => h.replace(/\./g, '\\.')).join('|');
  if (WIN) {
    console.log('windows: run in an ADMINISTRATOR PowerShell:');
    console.log(`  Copy-Item "${BACKUP}" "${HOSTS}" -Force; ipconfig /flushdns`);
    return { ok: false, manual: true };
  }
  // BSD sed (macOS) needs -i ''; GNU sed (linux) must NOT have it. Use a temp
  // file instead so one command is correct on both.
  // Both families, or the ::1 lines we now write would survive the unblock.
  const addr = '(127\\.0\\.0\\.1|::1)';
  const re = `/^[[:space:]]*${addr}[[:space:]]+(${pattern})[[:space:]]*$/d; /openzoo: force the editor/d`;
  const ok = privileged(
    `sed -E '${re}' ${HOSTS} > ${HOSTS}.oztmp && cat ${HOSTS}.oztmp > ${HOSTS} && rm -f ${HOSTS}.oztmp; `
    + flushDnsCmd(),
  );
  return { ok, blocked: isAnyBlocked() };
}

/**
 * Redirect 127.0.0.1:443 -> a high unprivileged port, so the impersonation
 * server (lib/cursorbackend.js) can answer api2.cursor.sh without running as
 * root. Applied in the SAME privileged step as the hosts entry; undone by
 * unblock. Platform-branched; on anything but macOS/Linux we print the command.
 */
export function redirect443(toPort, log = console.log) {
  if (process.platform === 'darwin') {
    // pf anchor scoped to loopback; -E keeps pf enabled, the anchor is ours to flush.
    const rule = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${toPort}`;
    const ok = privileged(`echo '${rule}' | pfctl -a openzoo -f - 2>/dev/null; pfctl -e 2>/dev/null; true`);
    return { ok };
  }
  if (process.platform === 'linux') {
    const ok = privileged(`iptables -t nat -C OUTPUT -p tcp -o lo --dport 443 -j REDIRECT --to-ports ${toPort} 2>/dev/null || iptables -t nat -A OUTPUT -p tcp -o lo --dport 443 -j REDIRECT --to-ports ${toPort}; true`);
    return { ok };
  }
  log(`  windows: run in an ADMINISTRATOR shell:`);
  log(`    netsh interface portproxy add v4tov4 listenport=443 listenaddress=127.0.0.1 connectport=${toPort} connectaddress=127.0.0.1`);
  return { ok: false, manual: true };
}

export function unredirect443() {
  if (process.platform === 'darwin') return { ok: privileged('pfctl -a openzoo -F all 2>/dev/null; true') };
  if (process.platform === 'linux') return { ok: privileged('iptables -t nat -D OUTPUT -p tcp -o lo --dport 443 -j REDIRECT --to-ports 8443 2>/dev/null; true') };
  return { ok: false, manual: true };
}

/**
 * Bind the impersonation backend on 127.0.0.1:443 as ROOT — the reliable path
 * after pfctl loopback redirect proved not to deliver on macOS. Spawned detached
 * inside the SAME sudo prompt used for the hosts entry; only this static server
 * runs privileged, never the wallet-holding proxy. unbindBackend443 kills it.
 */
export function bindBackend443(modelsPath, logPath, log = console.log) {
  // sudo strips the environment, so forward the one var the backend needs to
  // report the right membership in the stripe profile it serves.
  const memEnv = `OPENZOO_MEMBERSHIP='${(process.env.OPENZOO_MEMBERSHIP || 'pro').replace(/'/g, '')}'`;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, '..', 'bin', 'cursor-backend.js');
  const node = process.execPath;
  if (WIN) {
    log('  windows: run in an ADMINISTRATOR shell:');
    log(`    "${node}" "${script}" 443 "${modelsPath}" "${logPath}"`);
    return { ok: false, manual: true };
  }
  // KILL THE OLD ROOT BACKEND FIRST, HARD, AND WAIT FOR 443 TO FREE.
  // A prior version's root-owned listener keeps holding 443; `pkill openzoo` as
  // the user cannot touch it, so the new backend hit "port taken" and the OLD,
  // broken one kept answering — the reason a fix looked like it never landed.
  // We SIGKILL by name AND by whoever holds 443, poll until the port is actually
  // free (up to ~5s), then start the new one.
  // FLUSH THE OLD pfctl 443->8443 REDIRECT FIRST. Versions 0.29.0-0.29.2 installed
  // a pf anchor that redirects 443 to a stale user-process backend on 8443. While
  // that rule is loaded, pf intercepts 443 BEFORE our new root bind ever sees it,
  // so every fix looked like it never landed. Flush the anchor + kill 8443 + kill
  // 443 by name and by port, wait for both to free, THEN bind.
  const flushPf = process.platform === 'darwin' ? 'pfctl -a openzoo -F all 2>/dev/null; ' : '';
  const ok = privileged(
    flushPf
    + `pkill -9 -f 'cursor-backend.js' 2>/dev/null; `
    + `for p in $(lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null) $(lsof -nP -iTCP:8443 -sTCP:LISTEN -t 2>/dev/null); do kill -9 "$p" 2>/dev/null; done; `
    + `for i in 1 2 3 4 5 6 7 8 9 10; do lsof -nP -iTCP:443 -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 0.5; done; `
    // NEVER >/dev/null THE ROOT BACKEND. It is the only privileged half, it is
    // spawned detached, and if it dies at startup (port taken, bad models file,
    // module error) discarding its output leaves no evidence anywhere — the
    // failure mode this cost a session to find was exactly that: no listener on
    // 443, no cursor-backend.log, nothing to read. Send both streams to the log
    // the caller already passes, so a crash is on disk.
    + `mkdir -p "$(dirname '${logPath}')" 2>/dev/null; `
    // `nohup VAR=val prog` DOES NOT WORK. nohup execs its first argument as a
    // program; it is not a shell and does not parse leading VAR=val assignments.
    // The old form died instantly with "nohup: OPENZOO_MEMBERSHIP=pro: No such
    // file or directory" — the backend never started, nothing held :443, and
    // before the logging fix above that message went to /dev/null and the
    // failure was invisible. `env` is the program that does understand it.
    + `nohup env ${memEnv} '${node}' '${script}' 443 '${modelsPath}' '${logPath}' >>'${logPath}' 2>&1 & `
    + 'sleep 1; true',
  );
  // Report whether it ACTUALLY came up rather than whether sudo exited 0 —
  // `nohup ... &` always succeeds, so `ok` alone said nothing about the bind.
  //
  // PROBE BY CONNECTING, NOT BY lsof. The backend we just started is ROOT-owned;
  // unprivileged `lsof -iTCP:443` cannot see another user's descriptors and exits
  // 1 even while `netstat -an` shows `*.443 LISTEN`. That false negative made the
  // caller tear down a WORKING setup and print "FAILED to bind" directly under
  // the backend's own "listening on [::]+127.0.0.1:443" log line. A TCP connect
  // is ownership-blind, and it proves the far more useful property anyway: that
  // the socket actually accepts. Try both families — hosts.js pins both.
  const listening = spawnSync(node, ['-e', `
    const net = require('net');
    const hit = (host) => new Promise((r) => {
      const s = net.connect({ host, port: 443 });
      s.setTimeout(1000);
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
      s.on('timeout', () => { s.destroy(); r(false); });
    });
    (async () => {
      for (let i = 0; i < 10; i++) {
        if (await hit('127.0.0.1') || await hit('::1')) process.exit(0);
        await new Promise((r) => setTimeout(r, 500));
      }
      process.exit(1);
    })();
  `], { timeout: 20000 }).status === 0;
  if (!listening) {
    log(`  backend did NOT bind :443 — see ${logPath}`);
    try {
      const tail = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-8);
      for (const l of tail) log(`    ${l}`);
    } catch { log('    (no log written — the process died before it could open one)'); }
  }
  return { ok: ok && listening, listening };
}

export function unbindBackend443() {
  if (WIN) return { ok: false, manual: true };
  const flushPf = process.platform === 'darwin' ? 'pfctl -a openzoo -F all 2>/dev/null; ' : '';
  return { ok: privileged(
    flushPf
    + "pkill -9 -f 'cursor-backend.js' 2>/dev/null; "
    // 443 as well as 8443: the backend binds :443 directly now, and this runs
    // under sudo so lsof CAN see the root-owned socket here.
    + 'for p in $(lsof -nP -iTCP:443 -sTCP:LISTEN -t 2>/dev/null) $(lsof -nP -iTCP:8443 -sTCP:LISTEN -t 2>/dev/null); do kill -9 "$p" 2>/dev/null; done; true',
  ) };
}
