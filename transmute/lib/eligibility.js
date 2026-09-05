// Eligibility rules: which Lambdas can be re-hosted on chain, and why not.
//
// A handler is eligible when everything it does can be expressed in the
// zoo-host subset: pure computation over JS values, the request/response
// bridge, `@vercel/kv`, the baked environment table and the cluster clock.
// Anything that reaches outside the transaction (network, filesystem,
// timers, randomness) or outside the subset (classes, generators, regex)
// makes the whole function ineligible; the reason carries `file:line` so the
// user can fix or exclude it.
import path from 'node:path';

export class Ineligible extends Error {
  constructor(reason, { file = null, line = null, node = null } = {}) {
    super(reason);
    this.name = 'Ineligible';
    this.reason = reason;
    this.file = file;
    this.line = line ?? node?.loc?.start?.line ?? null;
  }
  toJSON() {
    return { reason: this.reason, file: this.file, line: this.line };
  }
  /** "reason (file:line)" */
  describe() {
    const where = this.file ? ` (${this.file}${this.line ? ':' + this.line : ''})` : this.line ? ` (line ${this.line})` : '';
    return this.reason + where;
  }
}

/** Throw an Ineligible for an AST node. */
export function ineligible(reason, node, file) {
  return new Ineligible(reason, { file, node });
}

// ---------------------------------------------------------------- imports

/**
 * Module specifiers we know how to bind. Each entry maps an imported name to
 * a "special" the lowering understands, or `null` for names that are types /
 * inert at runtime (safe to ignore).
 */
export const ALLOWED_IMPORTS = {
  '@vercel/kv': { kv: 'Kv', default: 'Kv', createClient: 'KvFactory', VercelKV: null },
  'next/server': { NextResponse: 'NextResponse', NextRequest: null, userAgent: 'ineligible:userAgent() reads the request UA table, which is not available on chain', after: 'ineligible:after() schedules work past the response; there is no "after" on chain' },
  'next': { NextApiRequest: null, NextApiResponse: null, NextApiHandler: null, PageConfig: null, GetServerSideProps: null },
  'next/types': { '*': null },
  '@vercel/node': { VercelRequest: null, VercelResponse: null, VercelApiHandler: null },
  '@vercel/edge': { '*': 'ineligible:@vercel/edge helpers (geolocation/ipAddress/rewrite) read edge-network state that does not exist on chain' },
  '@vercel/functions': { '*': 'ineligible:@vercel/functions (waitUntil/geolocation/ipAddress) is not available on chain: nothing runs after the transaction' },
  'next/headers': { '*': 'ineligible:next/headers (cookies()/headers()) is not supported yet; read request.headers / request.cookies instead' },
  'next/navigation': { '*': 'ineligible:next/navigation is a rendering API, not a route API' },
  'next/cache': { '*': 'ineligible:next/cache (revalidatePath/revalidateTag/unstable_cache) has no meaning on chain' },
};

/** Resolve one import. Returns [{local, special|null}] or throws Ineligible. */
export function bindImport(source, specifiers, { file, line } = {}) {
  const where = { file, line };
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('@/') || source.startsWith('~/')) {
    throw new Ineligible(`import of local module \`${source}\`: local imports are not transmuted yet; inline the helper into the route file`, where);
  }
  if (source.startsWith('node:') || NODE_BUILTINS.has(source)) {
    throw new Ineligible(`import of Node built-in \`${source}\`: no filesystem, network, crypto or process access on chain`, where);
  }
  const table = ALLOWED_IMPORTS[source];
  if (!table) {
    throw new Ineligible(`import of \`${source}\`: only @vercel/kv, next/server, and the next / @vercel/node types can be used on chain`, where);
  }
  const out = [];
  for (const s of specifiers) {
    const imported = s.imported === undefined ? 'default' : s.imported;
    let special;
    if (imported === '*') {
      special = { t: 'Namespace', source };
    } else {
      const entry = imported in table ? table[imported] : table['*'];
      if (entry === undefined) {
        throw new Ineligible(`\`${imported}\` is not a known export of ${source} (supported: ${Object.keys(table).filter((k) => k !== '*').join(', ')})`, where);
      }
      if (typeof entry === 'string' && entry.startsWith('ineligible:')) {
        throw new Ineligible(entry.slice('ineligible:'.length), where);
      }
      special = entry ? { t: entry } : null;
    }
    out.push({ local: s.local, imported, special });
  }
  return out;
}

export const NODE_BUILTINS = new Set([
  'fs', 'fs/promises', 'path', 'os', 'http', 'https', 'net', 'dns', 'crypto', 'child_process', 'stream', 'util', 'url', 'zlib',
  'events', 'buffer', 'querystring', 'readline', 'worker_threads', 'cluster', 'tls', 'dgram', 'assert', 'module', 'process', 'timers',
  'timers/promises', 'string_decoder', 'perf_hooks', 'async_hooks', 'vm', 'v8', 'inspector', 'tty', 'punycode', 'constants', 'sys',
]);

// ---------------------------------------------------------------- globals

/** Free identifiers that are meaningful on chain. Everything else is unknown. */
export const KNOWN_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'Date', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'console', 'process', 'Response', 'URL', 'Promise', 'Request', 'Headers', 'globalThis',
]);

/** Free identifiers with a specific reason for being unavailable. */
export const BANNED_GLOBALS = {
  fetch: 'fetch(): network access is not available on chain (a Solana instruction cannot make HTTP requests)',
  require: 'require(): dynamic module loading is not available on chain',
  setTimeout: 'setTimeout: timers are not available on chain (instructions are synchronous)',
  setInterval: 'setInterval: timers are not available on chain',
  setImmediate: 'setImmediate: timers are not available on chain',
  queueMicrotask: 'queueMicrotask: no event loop on chain',
  Buffer: 'Buffer is not available on chain; work with strings and arrays',
  crypto: 'crypto / Web Crypto is not available on chain',
  TextEncoder: 'TextEncoder is not available on chain',
  TextDecoder: 'TextDecoder is not available on chain',
  XMLHttpRequest: 'XMLHttpRequest: network access is not available on chain',
  WebSocket: 'WebSocket: network access is not available on chain',
  window: '`window` does not exist in a Lambda',
  document: '`document` does not exist in a Lambda',
  eval: 'eval() is not supported',
  Function: 'the Function constructor is not supported',
  Map: 'Map is not supported on chain; use a plain object',
  Set: 'Set is not supported on chain; use an array',
  WeakMap: 'WeakMap is not supported on chain',
  WeakSet: 'WeakSet is not supported on chain',
  Symbol: 'Symbol is not supported on chain',
  Proxy: 'Proxy is not supported on chain',
  Reflect: 'Reflect is not supported on chain',
  RegExp: 'regular expressions are not supported on chain',
  Intl: 'Intl is not available on chain',
  BigInt: 'BigInt is not supported on chain (numbers are f64)',
  ArrayBuffer: 'typed arrays / ArrayBuffer are not supported on chain',
  Uint8Array: 'typed arrays are not supported on chain',
  Int32Array: 'typed arrays are not supported on chain',
  Float64Array: 'typed arrays are not supported on chain',
  DataView: 'DataView is not supported on chain',
  structuredClone: 'structuredClone is not available on chain; use JSON.parse(JSON.stringify(x))',
  FormData: 'FormData is not supported on chain; send JSON',
  Blob: 'Blob is not supported on chain',
  File: 'File is not supported on chain',
  ReadableStream: 'streaming responses are not supported on chain',
  WritableStream: 'streaming responses are not supported on chain',
  TransformStream: 'streaming responses are not supported on chain',
  AbortController: 'AbortController is not available on chain',
  performance: 'performance.now() is not available on chain; use Date.now()',
  navigator: '`navigator` does not exist in a Lambda',
  atob: 'base64 helpers are not available on chain yet',
  btoa: 'base64 helpers are not available on chain yet',
  WebAssembly: 'WebAssembly is not available on chain',
  URLSearchParams: 'constructing URLSearchParams is not supported yet; read request.nextUrl.searchParams / req.query',
  Headers: 'constructing Headers is not supported; pass a plain object as `headers` in the Response init',
  Request: 'constructing a Request is not supported on chain',
};

/** Method names the on-chain `Val::call` implements (union over receiver types). */
export const RUNTIME_METHODS = new Set([
  // strings
  'toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd', 'includes', 'startsWith', 'endsWith', 'indexOf', 'split', 'slice',
  'substring', 'substr', 'charAt', 'charCodeAt', 'replace', 'replaceAll', 'repeat', 'padStart', 'padEnd', 'toString', 'valueOf',
  'concat', 'at',
  // arrays
  'push', 'pop', 'shift', 'unshift', 'join', 'splice', 'reverse', 'flat', 'map', 'filter', 'find', 'findIndex', 'some', 'every',
  'forEach', 'reduce', 'flatMap', 'sort',
  // numbers
  'toFixed',
  // objects
  'hasOwnProperty',
]);
export const CALLBACK_METHODS = new Set(['map', 'filter', 'find', 'findIndex', 'some', 'every', 'forEach', 'reduce', 'flatMap', 'sort']);
export const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort']);

/** `Math.*` the runtime implements. */
export const MATH_FUNCS = new Set(['floor', 'ceil', 'round', 'trunc', 'abs', 'sqrt', 'pow', 'sign', 'log', 'log2', 'log10', 'exp', 'sin', 'cos', 'tan', 'atan2', 'min', 'max', 'hypot']);
export const MATH_CONSTS = { PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E, SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2 };
export const GLOBAL_FUNCS = new Set(['Number', 'String', 'Boolean', 'isNaN', 'isFinite', 'parseFloat', 'parseInt', 'encodeURIComponent', 'encodeURI', 'decodeURIComponent', 'decodeURI']);

/** `kv.<method>` → runtime call. Anything else is ineligible. */
export const KV_METHODS = {
  get: 'kv_get', set: 'kv_set', incr: 'kv_incr', incrby: 'kv_incrby', decr: 'kv_decr', decrby: 'kv_decrby', del: 'kv_del', exists: 'kv_exists',
};

// ---------------------------------------------------------------- function metadata

/** Reasons that come from the Lambda's config rather than its code. `null` when fine. */
export function functionMetaReason(fn) {
  if (fn.middleware) return 'middleware runs before routing on the edge network; the gateway serves routes directly, so middleware is not transmuted';
  if (fn.supportsResponseStreaming) return 'streaming responses (supportsResponseStreaming) are not possible: an instruction answers once';
  if (fn.prerender) return 'ISR / prerender config: this function is a rendered page cache, not an API handler';
  if (fn.runtime && fn.runtime !== 'edge' && !/^nodejs\d+\.x$/.test(fn.runtime)) return `runtime \`${fn.runtime}\` is not JavaScript; only nodejs*.x and edge Lambdas are transmuted`;
  if (!fn.sourceFile) return 'no source file for this function';
  return null;
}

/** Non-blocking warnings for the whole deployment. */
export function deploymentWarnings(deployment) {
  const out = [];
  for (const c of deployment.crons || []) out.push(`cron \`${c.schedule || '?'}\` → ${c.path || '?'}: crons are not supported on chain (nothing schedules an instruction); the route itself may still be served`);
  for (const fn of deployment.functions || []) {
    if (fn.middleware) out.push(`${fn.name}: middleware is skipped (see report.ineligible)`);
    if (fn.prerender) out.push(`${fn.name}: ISR/prerender config is ignored`);
    if (fn.maxDuration && fn.maxDuration > 60) out.push(`${fn.name}: maxDuration=${fn.maxDuration}s has no effect; an instruction is bounded by compute units, not seconds`);
  }
  for (const n of deployment.notes || []) out.push(n);
  return out;
}

/** Display path for a function source relative to the deployment root. */
export function displayFile(fn, root) {
  if (!fn?.sourceFile) return fn?.name || '?';
  return root ? path.relative(root, fn.sourceFile) || fn.sourceFile : fn.sourceFile;
}
