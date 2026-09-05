// The Vercel deployment model, in Vercel's own terms.
//
// `vercel build` produces the Build Output API v3 tree:
//
//   .vercel/output/
//     config.json                 { version: 3, routes, overrides, images, crons, wildcard, framework }
//     static/**                   served as-is (highest precedence after `routes` w/ handle:filesystem)
//     functions/<name>.func/
//       .vc-config.json           { runtime, handler | entrypoint, launcherType, shouldAddHelpers,
//                                   maxDuration, memory, regions, environment, supportsResponseStreaming,
//                                   operationType, framework, architecture, ... }
//       <bundle files>
//     functions/<name>.prerender-config.json   (ISR)
//
// A `nodejs*.x` function is an AWS Lambda whose handler is wrapped by Vercel's
// node-bridge launcher: the Lambda receives `{Action:"Invoke", body:
// JSON{method, path, headers, encoding, body}}` and returns `{statusCode,
// headers, encoding, body}`. That bridge contract is what this package
// re-hosts on Solana (see wire.js).
//
// This module reads a real `.vercel/output` when present, and otherwise
// synthesizes the same model straight from a Next.js (pages/ or app/) or a
// Vite-style repo with an `api/` directory — the same routes `@vercel/next`
// and `@vercel/node` would emit, minus the bundling.
import fs from 'node:fs';
import path from 'node:path';

export const NODE_RUNTIMES = /^nodejs\d+\.x$/;
export const HANDLER_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];

/** One Lambda in Vercel terms. */
export class VercelFunction {
  constructor(o) {
    this.name = o.name;                       // "api/hello" — the .func dir name
    this.routePath = o.routePath;             // "/api/hello" or "/api/users/[id]"
    this.pattern = o.pattern;                 // regex source matching the route path
    this.params = o.params || [];             // ["id"] for dynamic segments
    this.runtime = o.runtime || 'nodejs20.x';
    this.launcherType = o.launcherType || 'Nodejs';
    this.shouldAddHelpers = o.shouldAddHelpers ?? true;   // Vercel's req.query/req.body/res.json helpers
    this.handler = o.handler || 'index.js';   // Lambda handler file
    this.entrypoint = o.entrypoint;           // edge functions
    this.sourceFile = o.sourceFile;           // absolute path to the source we transmute
    this.maxDuration = o.maxDuration ?? 10;   // seconds (Hobby default)
    this.memory = o.memory ?? 1024;           // MB
    this.regions = o.regions || ['iad1'];
    this.environment = o.environment || {};
    this.supportsResponseStreaming = !!o.supportsResponseStreaming;
    this.operationType = o.operationType || 'API';
    this.methods = o.methods || null;         // app-router exports (GET/POST...) or null = any
    this.style = o.style;                     // 'pages' | 'app' | 'vercel-node'
    this.framework = o.framework || null;
    this.prerender = o.prerender || null;     // ISR config, if any
    this.middleware = !!o.middleware;
    this.isEdge = this.runtime === 'edge';
  }
}

export class VercelDeployment {
  constructor(o) {
    this.root = o.root;
    this.source = o.source;                   // 'build-output' | 'nextjs' | 'vite' | 'vercel-node'
    this.framework = o.framework || null;
    this.config = o.config;                   // Build Output API config.json (routes, overrides, ...)
    this.staticDir = o.staticDir;             // absolute dir served as static/, or null
    this.staticFiles = o.staticFiles || [];   // [{ path: '/index.html', file: abs, contentType }]
    this.functions = o.functions || [];       // VercelFunction[]
    this.crons = o.crons || [];
    this.notes = o.notes || [];
  }
}

// ---------------------------------------------------------------- content types

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
export function contentTypeFor(p) {
  return CONTENT_TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------- route paths

/** Turn a file-system route ("api/users/[id]/index.js", "api/[...slug].ts") into Vercel's route shape. */
export function routeFromFile(rel, style) {
  let p = rel.replace(/\\/g, '/');
  p = p.replace(/\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/, '');
  if (style === 'app') p = p.replace(/\/route$/, '');
  p = p.replace(/\/index$/, '');
  if (p === 'index') p = '';
  const params = [];
  const segs = p.split('/').filter(Boolean).map((seg) => {
    if (style === 'app' && /^\(.*\)$/.test(seg)) return null; // route groups
    let m;
    if ((m = seg.match(/^\[\[\.\.\.(.+)\]\]$/))) { params.push(m[1]); return { re: '(?:/(.*))?', optional: true }; }
    if ((m = seg.match(/^\[\.\.\.(.+)\]$/))) { params.push(m[1]); return { re: '/(.+)' }; }
    if ((m = seg.match(/^\[(.+)\]$/))) { params.push(m[1]); return { re: '/([^/]+)' }; }
    return { re: '/' + seg.replace(/[.*+?^${}()|\\]/g, '\\$&') };
  }).filter(Boolean);
  const routePath = '/' + p.split('/').filter((s) => !(style === 'app' && /^\(.*\)$/.test(s))).join('/');
  const pattern = '^' + (segs.length ? segs.map((s) => s.re).join('') : '/?') + '/?$';
  return { routePath: routePath === '/' ? '/' : routePath.replace(/\/$/, ''), pattern, params };
}

function walk(dir, { skip = [] } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, { skip }));
    else out.push(p);
  }
  return out;
}

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Detect app-router HTTP method exports without parsing (cheap; the compiler re-checks). */
export function detectMethods(src) {
  const m = new Set();
  for (const x of src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/g)) m.add(x[1]);
  for (const x of src.matchAll(/export\s+(?:const|let)\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s*=/g)) m.add(x[1]);
  for (const x of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of x[1].split(',')) { const t = n.trim().split(/\s+as\s+/).pop(); if (/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)$/.test(t)) m.add(t); }
  return m.size ? [...m] : null;
}

export function detectRuntimeConfig(src) {
  const edge = /export\s+const\s+(?:config\s*=\s*\{[^}]*runtime\s*:\s*['"]edge['"]|runtime\s*=\s*['"]edge['"])/.test(src);
  const md = src.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/);
  return { runtime: edge ? 'edge' : 'nodejs20.x', maxDuration: md ? Number(md[1]) : undefined };
}

// ---------------------------------------------------------------- readers

/** Read a real `.vercel/output` (Build Output API v3). */
export function readBuildOutput(root) {
  const out = path.join(root, '.vercel', 'output');
  const config = readJson(path.join(out, 'config.json'), { version: 3, routes: [] });
  const staticDir = path.join(out, 'static');
  const staticFiles = walk(staticDir).map((f) => ({
    path: '/' + path.relative(staticDir, f).replace(/\\/g, '/'), file: f, contentType: contentTypeFor(f), size: fs.statSync(f).size,
  }));
  const functions = [];
  const fdir = path.join(out, 'functions');
  const notes = [];
  const findFunc = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name.endsWith('.func')) {
        const vc = readJson(path.join(p, '.vc-config.json'), {});
        const name = path.relative(fdir, p).replace(/\\/g, '/').replace(/\.func$/, '');
        const prerender = readJson(path.join(dir, e.name.replace(/\.func$/, '.prerender-config.json')));
        const handlerFile = vc.handler || vc.entrypoint;
        const { routePath, pattern, params } = routeFromFile(name, 'pages');
        functions.push(new VercelFunction({
          name, routePath, pattern, params, runtime: vc.runtime, launcherType: vc.launcherType, shouldAddHelpers: vc.shouldAddHelpers,
          handler: vc.handler, entrypoint: vc.entrypoint, sourceFile: handlerFile ? path.join(p, handlerFile) : null,
          maxDuration: vc.maxDuration, memory: vc.memory, regions: vc.regions, environment: vc.environment,
          supportsResponseStreaming: vc.supportsResponseStreaming, operationType: vc.operationType, framework: vc.framework,
          prerender, style: 'build-output', middleware: name === 'middleware' || name === '_middleware',
        }));
      } else if (e.isDirectory()) findFunc(p);
    }
  };
  findFunc(fdir);
  notes.push('read from .vercel/output (Build Output API v3); bundled function handlers are transmuted from their handler file');
  return new VercelDeployment({ root, source: 'build-output', framework: config.framework?.slug || null, config, staticDir, staticFiles, functions, crons: config.crons || [], notes });
}

/** Synthesize the model from a Next.js repo (pages/api and app router route files). */
export function readNextjs(root) {
  const pkg = readJson(path.join(root, 'package.json'), {});
  const srcRoots = [root, path.join(root, 'src')];
  const functions = [];
  const notes = [];
  for (const base of srcRoots) {
    const pagesApi = path.join(base, 'pages', 'api');
    for (const f of walk(pagesApi)) {
      if (!HANDLER_EXTS.includes(path.extname(f))) continue;
      const rel = 'api/' + path.relative(pagesApi, f).replace(/\\/g, '/');
      const src = fs.readFileSync(f, 'utf8');
      const rc = detectRuntimeConfig(src);
      const { routePath, pattern, params } = routeFromFile(rel, 'pages');
      functions.push(new VercelFunction({ name: rel.replace(/\.[^.]+$/, ''), routePath, pattern, params, sourceFile: f, style: 'pages', runtime: rc.runtime, maxDuration: rc.maxDuration, framework: { slug: 'nextjs', version: pkg.dependencies?.next } }));
    }
    const app = path.join(base, 'app');
    for (const f of walk(app)) {
      const bn = path.basename(f).replace(/\.[^.]+$/, '');
      if (bn !== 'route' || !HANDLER_EXTS.includes(path.extname(f))) continue;
      const rel = path.relative(app, f).replace(/\\/g, '/');
      const src = fs.readFileSync(f, 'utf8');
      const rc = detectRuntimeConfig(src);
      const { routePath, pattern, params } = routeFromFile(rel, 'app');
      functions.push(new VercelFunction({ name: rel.replace(/\/route\.[^.]+$/, ''), routePath, pattern, params, sourceFile: f, style: 'app', methods: detectMethods(src), runtime: rc.runtime, maxDuration: rc.maxDuration, framework: { slug: 'nextjs', version: pkg.dependencies?.next } }));
    }
    for (const mw of ['middleware.js', 'middleware.ts']) {
      const f = path.join(base, mw);
      if (fs.existsSync(f)) functions.push(new VercelFunction({ name: 'middleware', routePath: '/', pattern: '^/.*$', sourceFile: f, style: 'app', middleware: true, runtime: 'edge' }));
    }
  }
  // A top-level `api/` next to a Next.js app is built by @vercel/node exactly
  // as it is in a Vite repo (Vercel's docs call these "Serverless Functions"
  // outside the framework); `next build` ignores it, `vercel build` does not.
  // A pages/api route with the same name wins, as it does on Vercel.
  for (const f of readVercelNode(root).functions) {
    if (!functions.some((g) => g.name === f.name)) functions.push(f);
  }
  // A top-level `api/` next to pages/app is built by @vercel/node too (Vite-style functions in a Next repo).
  for (const f of walk(path.join(root, 'api'))) {
    if (!HANDLER_EXTS.includes(path.extname(f))) continue;
    const rel = 'api/' + path.relative(path.join(root, 'api'), f).replace(/\\/g, '/');
    const name = rel.replace(/\.[^.]+$/, '');
    if (functions.some((fn) => fn.name === name)) continue;
    const src = fs.readFileSync(f, 'utf8');
    const rc = detectRuntimeConfig(src);
    const { routePath, pattern, params } = routeFromFile(rel, 'pages');
    functions.push(new VercelFunction({ name, routePath, pattern, params, sourceFile: f, style: 'vercel-node', methods: detectMethods(src), runtime: rc.runtime, maxDuration: rc.maxDuration }));
  }
  // Static: `public/` is copied verbatim by @vercel/next; `out/` exists after `next build` with output:'export'.
  const staticDir = fs.existsSync(path.join(root, 'out')) ? path.join(root, 'out') : path.join(root, 'public');
  if (!fs.existsSync(path.join(root, 'out'))) notes.push("no `out/` directory: only `public/` is treated as static. Run `next build` with `output: 'export'` in next.config to ship the rendered pages.");
  const staticFiles = walk(staticDir).map((f) => ({ path: '/' + path.relative(staticDir, f).replace(/\\/g, '/'), file: f, contentType: contentTypeFor(f), size: fs.statSync(f).size }));
  const vercelJson = readJson(path.join(root, 'vercel.json'), {});
  const config = {
    version: 3,
    routes: [...(vercelJson.rewrites || []).map((r) => ({ src: r.source, dest: r.destination })), { handle: 'filesystem' }, ...functions.filter((f) => !f.middleware).map((f) => ({ src: f.pattern, dest: f.routePath }))],
    overrides: {},
    framework: { slug: 'nextjs', version: pkg.dependencies?.next || null },
  };
  applyEnv(functions, root);
  return new VercelDeployment({ root, source: 'nextjs', framework: 'nextjs', config, staticDir, staticFiles, functions, crons: vercelJson.crons || [], notes });
}

/** Vite / static repos with a top-level `api/` (what @vercel/node builds). */
export function readVercelNode(root) {
  const pkg = readJson(path.join(root, 'package.json'), {});
  const api = path.join(root, 'api');
  const functions = walk(api).filter((f) => HANDLER_EXTS.includes(path.extname(f))).map((f) => {
    const rel = 'api/' + path.relative(api, f).replace(/\\/g, '/');
    const src = fs.readFileSync(f, 'utf8');
    const rc = detectRuntimeConfig(src);
    const { routePath, pattern, params } = routeFromFile(rel, 'pages');
    return new VercelFunction({ name: rel.replace(/\.[^.]+$/, ''), routePath, pattern, params, sourceFile: f, style: 'vercel-node', methods: detectMethods(src), runtime: rc.runtime, maxDuration: rc.maxDuration });
  });
  const vercelJson = readJson(path.join(root, 'vercel.json'), {});
  const candidates = [vercelJson.outputDirectory, 'dist', 'build', 'public', '.'].filter(Boolean);
  const staticDir = candidates.map((d) => path.join(root, d)).find((d) => fs.existsSync(path.join(d, 'index.html'))) || path.join(root, 'public');
  const staticFiles = walk(staticDir, { skip: ['node_modules', 'api'] }).map((f) => ({ path: '/' + path.relative(staticDir, f).replace(/\\/g, '/'), file: f, contentType: contentTypeFor(f), size: fs.statSync(f).size }));
  const notes = [];
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) notes.push(`no built frontend found (looked for index.html in ${candidates.join(', ')}); run your \`vite build\` first`);
  const config = {
    version: 3,
    routes: [...(vercelJson.rewrites || []).map((r) => ({ src: r.source, dest: r.destination })), { handle: 'filesystem' }, ...functions.map((f) => ({ src: f.pattern, dest: f.routePath }))],
    overrides: {},
    framework: { slug: pkg.devDependencies?.vite || pkg.dependencies?.vite ? 'vite' : null },
  };
  applyEnv(functions, root);
  return new VercelDeployment({ root, source: 'vercel-node', framework: config.framework.slug, config, staticDir, staticFiles, functions, crons: vercelJson.crons || [], notes });
}

/** `.env.production` / `.env` become the Lambda `environment` table (baked into the program!). */
export function applyEnv(functions, root) {
  const env = {};
  for (const f of ['.env', '.env.production', '.env.local', '.env.production.local']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  for (const fn of functions) fn.environment = { ...env, ...fn.environment };
}

/** Pick the reader for a repo. */
export function readDeployment(root) {
  root = path.resolve(root);
  if (fs.existsSync(path.join(root, '.vercel', 'output', 'config.json'))) return readBuildOutput(root);
  const pkg = readJson(path.join(root, 'package.json'), {});
  const hasNext = !!(pkg.dependencies?.next || pkg.devDependencies?.next) || fs.existsSync(path.join(root, 'next.config.js')) || fs.existsSync(path.join(root, 'next.config.mjs')) || fs.existsSync(path.join(root, 'next.config.ts'));
  if (hasNext || fs.existsSync(path.join(root, 'pages', 'api')) || fs.existsSync(path.join(root, 'app'))) return readNextjs(root);
  return readVercelNode(root);
}
