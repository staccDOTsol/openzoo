/**
 * The smallest possible .env loader — no dependency, no magic.
 *
 * WHY IT EXISTS: credentialed URLs and tokens were being pasted onto
 * every command line, which puts them in shell history, in process
 * listings, and eventually in a screenshot. A file the repo ignores is
 * the right place for them.
 *
 * NEVER OVERRIDES a value already in the environment: an explicit
 * `FOO=bar node ...` must win over a stale line in a file, or debugging
 * becomes guesswork about which value is live.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadDotenv(file = path.join(HERE, '..', '.env')) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const loaded = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) { process.env[key] = val; loaded[key] = true; }
  }
  return loaded;
}
