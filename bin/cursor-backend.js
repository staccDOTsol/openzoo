#!/usr/bin/env node
/**
 * Standalone impersonation backend, meant to be spawned WITH PRIVILEGE so it can
 * bind 127.0.0.1:443 directly — the port the editor dials for api2.cursor.sh.
 *
 * WHY A SEPARATE ROOT PROCESS. Binding 443 needs root on unix, but the paying
 * proxy must NOT run as root (it holds the wallet). This process is static — it
 * serves a model catalog and empty stubs, touches no keys, no money — so running
 * only THIS as root is the safe split. The pfctl 443->8443 redirect that would
 * have avoided root does not deliver loopback-to-loopback on macOS (measured:
 * self-test FAIL), so a direct bind is the reliable path.
 *
 * argv: <port> <models.json> <log-file>
 */
import fs from 'node:fs';
import { startCursorBackend } from '../lib/cursorbackend.js';

const port = Number(process.argv[2] || 443);
const modelsPath = process.argv[3];
const logPath = process.argv[4];

// WRITE EACH LINE ONCE. The launcher now redirects this process's stdout+stderr
// with `>>` to the SAME logPath (so a startup crash leaves evidence), so doing
// both an explicit appendFileSync AND a stdout write duplicated every single
// line in the file. stdout alone is the right channel: it reaches the log via
// the redirect, and it still shows up when the backend is run by hand on a
// terminal for debugging.
const log = (s) => { process.stdout.write(`${s}\n`); };

let models = [];
try { models = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); }
catch (e) { log(`cursor-backend: could not read models (${e.message})`); process.exit(1); }

// NEVER LET ONE BAD REQUEST KILL THE SERVER. The h2 header bug threw out of an
// async handler, which is an unhandled rejection / uncaught throw at process
// level — node tore the whole backend down mid-request, so :443 went dead and
// every later attempt logged ECONNRESET with no listener behind it. This is a
// static impersonation server; staying up while logging the fault is always
// better than exiting and blackholing the host the app depends on.
process.on('uncaughtException', (e) => {
  log(`cursor-backend: UNCAUGHT ${e && e.code ? e.code + ' ' : ''}${e && e.message}`);
  if (e && e.stack) log(String(e.stack).split('\n').slice(1, 4).join('\n'));
});
process.on('unhandledRejection', (e) => {
  log(`cursor-backend: UNHANDLED REJECTION ${e && e.message ? e.message : e}`);
});

startCursorBackend({ port, models, log });
log(`cursor-backend: standalone up on :${port} (${models.length} models)`);
