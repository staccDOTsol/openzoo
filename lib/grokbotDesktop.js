/**
 * Drive the Mac UI from Grok Bot tools: click, type, key, AX dump.
 * JXA + CGEvent (no cliclick). Needs Accessibility for the node process
 * that runs `openzoo bot` (Terminal / iTerm / Grok).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);
const JXA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grokbotDesktop.jxa');

const APP_ALIASES = {
  brave: 'Brave Browser',
  chrome: 'Google Chrome',
  safari: 'Safari',
  grok: 'Grok Bot',
  finder: 'Finder',
};

export function resolveAppName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const hit = APP_ALIASES[s.toLowerCase()];
  return hit || s;
}

export function mapImageClick(imageX, imageY, meta) {
  const iw = Number(meta?.image?.width) || 0;
  const ih = Number(meta?.image?.height) || 0;
  const sw = Number(meta?.screen?.width) || 0;
  const sh = Number(meta?.screen?.height) || 0;
  if (!iw || !ih || !sw || !sh) return null;
  return {
    x: Math.round((Number(imageX) / iw) * sw),
    y: Math.round((Number(imageY) / ih) * sh),
  };
}

let lastShotMeta = null;
export function noteShotMeta(meta) {
  lastShotMeta = meta && typeof meta === 'object' ? meta : null;
  return lastShotMeta;
}
export function lastShot() {
  return lastShotMeta;
}

export async function displayBounds() {
  const { stdout } = await execFileAsync('osascript', [
    '-e',
    'tell application "Finder" to get bounds of window of desktop',
  ], { timeout: 8000 });
  const n = String(stdout).match(/-?\d+/g)?.map(Number) || [];
  const [x0, y0, x1, y1] = n;
  if (![x0, y0, x1, y1].every(Number.isFinite)) {
    throw new Error(`bad display bounds: ${stdout.trim()}`);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export async function imageSize(p) {
  const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', p], { timeout: 8000 });
  const w = Number(String(stdout).match(/pixelWidth:\s*(\d+)/)?.[1]);
  const h = Number(String(stdout).match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!w || !h) throw new Error(`sips no size for ${p}`);
  return { width: w, height: h };
}

export async function desktopAction(op, args = {}, log = () => {}) {
  if (!fs.existsSync(JXA_PATH)) throw new Error(`missing ${JXA_PATH}`);
  const payload = { op: String(op || ''), ...args };
  if (payload.app) payload.app = resolveAppName(payload.app);
  if (payload.image_x != null || payload.imageX != null) {
    const mapped = mapImageClick(payload.image_x ?? payload.imageX, payload.image_y ?? payload.imageY, lastShotMeta);
    if (mapped) {
      payload.x = mapped.x;
      payload.y = mapped.y;
      payload.mappedFromImage = true;
    }
  }
  log(`cursor-backend:      desktop ${payload.op} ${JSON.stringify({
    x: payload.x, y: payload.y, query: payload.query, key: payload.key, app: payload.app,
    n: payload.text ? String(payload.text).length : undefined,
  })}`);
  const { stdout, stderr } = await execFileAsync('osascript', [
    '-l', 'JavaScript', JXA_PATH, JSON.stringify(payload),
  ], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const raw = String(stdout || '').trim() || String(stderr || '').trim();
  try { return JSON.parse(raw); } catch {
    return { ok: false, error: raw || 'empty jxa' };
  }
}
