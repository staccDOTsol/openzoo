// Source → AST → module shape.
//
// * `stripTypes` is a conservative, position-preserving TypeScript stripper
//   (removed text becomes spaces, newlines stay) so acorn can parse `.ts`
//   route files and every reported line number still points at the source.
// * `parseModule` runs acorn (module first, script second for CommonJS).
// * `readModule` finds the Lambda handler(s): `export default (req, res)`,
//   app-router `export function GET/POST/...`, `module.exports = ...`, and
//   collects imports, module-scope declarations and config exports.
import path from 'node:path';
import * as acorn from 'acorn';
import { Ineligible } from '../eligibility.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// ---------------------------------------------------------------- code mask

const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * 1 for characters that are code, 0 for characters inside strings, template
 * literal text, comments and regex literals. Template `${...}` holes are code.
 */
export function codeMask(src) {
  const n = src.length;
  const mask = new Uint8Array(n).fill(1);
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) mask[k] = 0; };
  function scanString(i) {
    const q = src[i];
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === q || c === '\n') { j++; break; }
      j++;
    }
    blank(i, j);
    return j;
  }
  function scanRegex(i) {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') break;
      if (inClass) { if (c === ']') inClass = false; j++; continue; }
      if (c === '[') { inClass = true; j++; continue; }
      if (c === '/') { j++; break; }
      j++;
    }
    while (j < n && /[a-z]/.test(src[j])) j++;
    blank(i, j);
    return j;
  }
  function scanTemplate(i) {
    mask[i] = 0;
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { mask[j] = 0; if (j + 1 < n) mask[j + 1] = 0; j += 2; continue; }
      if (c === '`') { mask[j] = 0; return j + 1; }
      if (c === '$' && src[j + 1] === '{') {
        mask[j] = 0; mask[j + 1] = 0;
        const k = scanCode(j + 2, true);
        if (k < n) mask[k] = 0;
        j = k + 1;
        continue;
      }
      mask[j] = 0;
      j++;
    }
    return j;
  }
  function scanCode(i, stopAtBrace) {
    let depth = 0;
    let lastSig = '';
    let lastWord = '';
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
      if (c === '"' || c === "'") { i = scanString(i); lastSig = '"'; lastWord = ''; continue; }
      if (c === '`') { i = scanTemplate(i); lastSig = '"'; lastWord = ''; continue; }
      if (c === '/') {
        const prevIsOperand = lastSig === ')' || lastSig === ']' || lastSig === '"' || (isWord(lastSig) && !REGEX_PREV_WORDS.has(lastWord));
        if (!prevIsOperand) { i = scanRegex(i); lastSig = ')'; lastWord = ''; continue; }
      }
      if (c === '{') depth++;
      if (c === '}') { if (depth === 0 && stopAtBrace) return i; depth--; }
      if (!isSpace(c)) { lastSig = c; lastWord = isWord(c) ? lastWord + c : ''; }
      i++;
    }
    return i;
  }
  scanCode(0, false);
  return mask;
}

// ---------------------------------------------------------------- TypeScript stripping

/**
 * Best-effort removal of TypeScript syntax: type annotations on params /
 * returns / variables, `as` / `satisfies` casts, generics, `import type`,
 * `interface` / `type` declarations, non-null `!`, optional-param `?`.
 * Positions are preserved (removed text becomes spaces).
 */
export function stripTypes(src) {
  const mask = codeMask(src);
  const out = src.split('');
  const n = out.length;
  const code = (i) => i >= 0 && i < n && mask[i] === 1;
  const ch = (i) => (i >= 0 && i < n ? out[i] : '');
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  const skipWs = (i) => { while (i < n && (!code(i) || isSpace(out[i]))) i++; return i; };
  const skipWsNoNl = (i) => { while (i < n && (!code(i) || out[i] === ' ' || out[i] === '\t' || out[i] === '\r')) i++; return i; };
  const wordAt = (i) => { let j = i; while (j < n && code(j) && isWord(out[j])) j++; return out.slice(i, j).join(''); };
  const prevSig = (i) => { let j = i - 1; while (j >= 0 && (isSpace(out[j]) || (!code(j) && out[j] !== '"' && out[j] !== "'" && out[j] !== '`' && mask[j] === 0 && isBlankComment(j)))) j--; return j; };
  // A masked char that belongs to a comment (not a string) — treat like whitespace when looking backwards.
  function isBlankComment(j) {
    // walk back to the start of the masked run and see whether it begins with // or /*
    let k = j;
    while (k > 0 && mask[k - 1] === 0) k--;
    return out[k] === '/' && (out[k + 1] === '/' || out[k + 1] === '*');
  }
  const OPEN = { '(': ')', '[': ']', '{': '}', '<': '>' };
  /** Index of the bracket closing the one at i (only code chars count). `<` groups skip `=>`. */
  function matchClose(i) {
    const o = out[i];
    const c = OPEN[o];
    let depth = 0;
    for (let j = i; j < n; j++) {
      if (!code(j)) continue;
      const x = out[j];
      if (o === '<' && x === '=' && out[j + 1] === '>') { j++; continue; }
      if (x === o) depth++;
      else if (x === c) { depth--; if (depth === 0) return j; }
      else if (o === '<' && (x === ';' || x === '\n')) return -1;
    }
    return -1;
  }
  /**
   * Scan a type starting at i (first char after `:`/`as`). Returns the index just
   * past the type. `stops` are chars that end it at depth 0; `=>` ends it unless
   * the type started with a parenthesized group (function type).
   */
  function scanType(i, stops) {
    i = skipWs(i);
    let j = i;
    let first = true;
    let startedWithParen = false;
    let sawArrow = false;
    while (j < n) {
      if (!code(j)) { j++; continue; }
      const x = out[j];
      if (x === '\n') {
        // a type continues on the next line only with a continuation token
        const k = skipWs(j);
        if (k < n && (out[k] === '|' || out[k] === '&' || out[k] === '.' || (out[k] === '<' && !first))) { j = k; continue; }
        return j;
      }
      if (x === ' ' || x === '\t' || x === '\r') { j++; continue; }
      if (x === '=' && out[j + 1] === '>') {
        if (startedWithParen && !sawArrow) { sawArrow = true; j += 2; first = false; continue; }
        return j;
      }
      if (stops.includes(x)) return j;
      if (x === '{' && !first) return j;
      if ((x === '|' && out[j + 1] === '|') || (x === '&' && out[j + 1] === '&')) return j;
      if (x in OPEN) {
        if (first && x === '(') startedWithParen = true;
        const m = matchClose(j);
        if (m < 0) return j;
        j = m + 1;
        first = false;
        continue;
      }
      if (x === ')' || x === ']' || x === '}' || x === '>') return j;
      if (isWord(x) || x === '|' || x === '&' || x === '.' || x === '?' || x === ':' || x === '-' || x === '+') {
        // keywords that continue a type
        j++;
        first = false;
        continue;
      }
      return j;
    }
    return j;
  }
  // -- 0. protect import/export { ... } groups from `as` stripping, remove `type` specifiers
  const protectedRanges = [];
  for (let i = 0; i < n; i++) {
    if (!code(i)) continue;
    if (!(out[i] === 'i' || out[i] === 'e') || (i > 0 && isWord(ch(i - 1)))) continue;
    const w = wordAt(i);
    if (w !== 'import' && w !== 'export') continue;
    let j = skipWs(i + w.length);
    const w2 = wordAt(j);
    if (w2 === 'type') {
      // `import type X from`, `export type { X }`, `export type X = ...`
      const k = skipWs(j + 4);
      if (w === 'import' || out[k] === '{') {
        let end = k;
        if (out[k] === '{') { const m = matchClose(k); end = m < 0 ? k : m + 1; }
        // to end of statement: the module string or `;`/newline
        while (end < n && out[end] !== ';' && out[end] !== '\n') end++;
        blank(i, end + (out[end] === ';' ? 1 : 0));
        continue;
      }
      // export type X = T;
      let e = k;
      while (e < n && code(e) && out[e] !== '=' && out[e] !== '\n') e++;
      if (out[e] === '=') e = scanType(e + 1, [';']);
      blank(i, e + (out[e] === ';' ? 1 : 0));
      continue;
    }
    if (w === 'export' && (w2 === 'interface' || w2 === 'declare' || w2 === 'abstract')) continue; // handled below
    if (w === 'export' && w2 === 'default') { j = skipWs(j + 7); }
    if (out[j] === '*') { j = skipWs(j + 1); if (wordAt(j) === 'as') { j = skipWs(j + 2); j += wordAt(j).length; } }
    if (out[j] === '{') {
      const m = matchClose(j);
      if (m > 0) {
        protectedRanges.push([j, m]);
        // `type X,` / `type X as Y,` inside the braces
        let k = j + 1;
        while (k < m) {
          k = skipWs(k);
          if (k >= m) break;
          if (wordAt(k) === 'type' && isSpace(ch(k + 4))) {
            let e = skipWs(k + 4);
            e += wordAt(e).length;
            let e2 = skipWs(e);
            if (wordAt(e2) === 'as') { e2 = skipWs(e2 + 2); e2 += wordAt(e2).length; e = e2; }
            e2 = skipWs(e);
            if (out[e2] === ',') e = e2 + 1;
            blank(k, e);
            k = e;
            continue;
          }
          while (k < m && out[k] !== ',') k++;
          k++;
        }
      }
    }
  }
  const isProtected = (i) => protectedRanges.some(([a, b]) => i > a && i < b);

  // -- 1. interface / type / declare statements
  for (let i = 0; i < n; i++) {
    if (!code(i) || !isWord(out[i]) || (i > 0 && isWord(ch(i - 1)))) continue;
    const w = wordAt(i);
    if (w !== 'interface' && w !== 'type' && w !== 'declare' && w !== 'abstract') continue;
    // statement start: preceded by newline / ; / } / start or `export`
    const p = prevSig(i);
    let stmtStart = i;
    const pw = p >= 0 ? wordEndingAt(p) : '';
    if (pw === 'export') stmtStart = p - 5;
    else if (!(p < 0 || out[p] === ';' || out[p] === '}' || out[p] === '{' || out[p] === '\n' || lineBreakBetween(p, i))) continue;
    const next = skipWs(i + w.length);
    if (w === 'type') {
      if (!isWord(ch(next))) continue; // `type` used as an identifier
      let e = next;
      while (e < n && (code(e) ? out[e] !== '=' && out[e] !== '\n' : true)) e++;
      if (out[e] !== '=') continue;
      e = scanType(e + 1, [';']);
      blank(stmtStart, e + (out[e] === ';' ? 1 : 0));
      i = e;
      continue;
    }
    if (w === 'interface') {
      let k = next;
      while (k < n && out[k] !== '{') k++;
      const m = matchClose(k);
      if (m < 0) continue;
      blank(stmtStart, m + 1);
      i = m;
      continue;
    }
    if (w === 'declare' || w === 'abstract') {
      if (!isWord(ch(next))) continue;
      let k = next;
      let m = -1;
      while (k < n && out[k] !== ';' && out[k] !== '\n') { if (code(k) && out[k] === '{') { m = matchClose(k); break; } k++; }
      const end = m >= 0 ? m + 1 : k + (out[k] === ';' ? 1 : 0);
      blank(stmtStart, end);
      i = end;
    }
  }
  function wordEndingAt(p) {
    let s = p;
    while (s >= 0 && isWord(ch(s))) s--;
    return out.slice(s + 1, p + 1).join('');
  }
  function lineBreakBetween(a, b) {
    for (let k = a; k < b; k++) if (out[k] === '\n') return true;
    return false;
  }

  // -- 2. function generics, parameter lists, return types
  function stripParamList(open) {
    const close = matchClose(open);
    if (close < 0) return open;
    let i = open + 1;
    while (i < close) {
      if (!code(i)) { i++; continue; }
      const x = out[i];
      if (x === '(' || x === '[' || x === '{') { const m = matchClose(i); if (m < 0) break; i = m + 1; continue; }
      if (x === '?') {
        const k = skipWs(i + 1);
        if (out[k] === ':' || out[k] === ',' || out[k] === ')') { blank(i, i + 1); i++; continue; }
      }
      if (x === ':') {
        const e = scanType(i + 1, [',', ')', '=']);
        blank(i, e);
        i = e;
        continue;
      }
      if (x === '=' && out[i + 1] !== '>') {
        // default value: skip to the next top-level , or )
        let k = i + 1;
        while (k < close) {
          if (!code(k)) { k++; continue; }
          if (out[k] === '(' || out[k] === '[' || out[k] === '{') { const m = matchClose(k); if (m < 0) break; k = m + 1; continue; }
          if (out[k] === ',') break;
          k++;
        }
        i = k;
        continue;
      }
      i++;
    }
    return close;
  }
  function stripReturnType(afterClose, needArrow) {
    let k = skipWsNoNl(afterClose);
    if (out[k] !== ':') return needArrow ? -1 : k;
    const e = scanType(k + 1, ['{', ';', ',', ')', '=']);
    const after = skipWs(e);
    if (needArrow && !(out[after] === '=' && out[after + 1] === '>')) return -1;
    blank(k, e);
    return e;
  }
  for (let i = 0; i < n; i++) {
    if (!code(i)) continue;
    const x = out[i];
    if (isWord(x) && !(i > 0 && isWord(ch(i - 1)))) {
      const w = wordAt(i);
      if (w === 'function' || w === 'catch') {
        let j = skipWs(i + w.length);
        if (out[j] === '*') j = skipWs(j + 1);
        if (isWord(ch(j))) j = skipWs(j + wordAt(j).length);
        if (out[j] === '<') { const m = matchClose(j); if (m > 0) { blank(j, m + 1); j = skipWs(m + 1); } }
        if (out[j] === '(') {
          const close = stripParamList(j);
          if (w === 'function') stripReturnType(close + 1, false);
          i = j; // continue scanning inside the params (arrow defaults etc.)
        }
        continue;
      }
      i += w.length - 1;
      continue;
    }
    if (x === '(') {
      const close = matchClose(i);
      if (close < 0) continue;
      // arrow function?  ( ... ) [: T] =>
      let k = skipWsNoNl(close + 1);
      let isArrow = out[k] === '=' && out[k + 1] === '>';
      if (!isArrow && out[k] === ':') isArrow = stripReturnType(close + 1, true) >= 0;
      if (isArrow) stripParamList(i);
      continue;
    }
    if (x === '<') {
      // generic arrow `<T>(x: T) => ...` or `<T,>(...)`: previous is not an operand
      const p = prevSig(i);
      const pc = ch(p);
      if (p < 0 || '=(,:?[{;'.includes(pc) || wordEndingAt(p) === 'return') {
        const m = matchClose(i);
        if (m > 0) {
          const k = skipWs(m + 1);
          if (out[k] === '(') {
            const close = matchClose(k);
            const a = close > 0 ? skipWs(close + 1) : -1;
            const arrow = a >= 0 && ((out[a] === '=' && out[a + 1] === '>') || out[a] === ':');
            if (arrow) blank(i, m + 1);
          }
        }
      }
    }
  }

  // -- 3. variable annotations: const x: T = ...
  for (let i = 0; i < n; i++) {
    if (!code(i) || !isWord(out[i]) || (i > 0 && isWord(ch(i - 1)))) continue;
    const w = wordAt(i);
    if (w !== 'const' && w !== 'let' && w !== 'var') { i += w.length - 1; continue; }
    let j = skipWs(i + w.length);
    if (out[j] === '{' || out[j] === '[') { const m = matchClose(j); if (m < 0) continue; j = m + 1; }
    else if (isWord(ch(j))) j += wordAt(j).length;
    else continue;
    let k = skipWsNoNl(j);
    if (out[k] === '!') { blank(k, k + 1); k = skipWsNoNl(k + 1); }
    if (out[k] === ':') {
      const e = scanType(k + 1, ['=', ';', ',']);
      blank(k, e);
    }
  }

  // -- 4. `as T` / `satisfies T`
  for (let i = 0; i < n; i++) {
    if (!code(i) || (out[i] !== 'a' && out[i] !== 's') || (i > 0 && isWord(ch(i - 1))) || isProtected(i)) continue;
    const w = wordAt(i);
    if (w !== 'as' && w !== 'satisfies') { i += Math.max(0, w.length - 1); continue; }
    const p = prevSig(i);
    if (p < 0) continue;
    const pc = out[p];
    const operand = isWord(pc) || pc === ')' || pc === ']' || pc === '}' || mask[p] === 0 || pc === '>';
    if (!operand) continue;
    if (isWord(pc)) {
      const pw = wordEndingAt(p);
      if (['return', 'typeof', 'case', 'in', 'of', 'import', 'export', 'new', 'await', 'yield', 'throw', 'delete', 'void'].includes(pw)) continue;
    }
    const after = skipWsNoNl(i + w.length);
    if (!(isWord(ch(after)) || out[after] === '{' || out[after] === '(' || out[after] === '[' || mask[after] === 0)) continue;
    const e = scanType(i + w.length, [',', ')', ']', '}', ';', '=', '?', ':', '!', '+', '-', '*', '/', '%', '^', '~', '<']);
    blank(i, e);
    i = e;
  }

  // -- 5. call / new generics: `name<T>(`
  for (let i = 0; i < n; i++) {
    if (!code(i) || out[i] !== '<') continue;
    const p = i - 1;
    if (!(p >= 0 && code(p) && isWord(out[p]))) continue;
    const m = matchClose(i);
    if (m < 0) continue;
    const inner = out.slice(i + 1, m).join('');
    if (/[;\n]/.test(inner) || /&&|\|\|/.test(inner) || inner.trim() === '') continue;
    const k = skipWsNoNl(m + 1);
    if (out[k] === '(' || out[k] === '`') blank(i, m + 1);
  }

  // -- 6. non-null assertions `x!`
  for (let i = 1; i < n; i++) {
    if (!code(i) || out[i] !== '!' || out[i + 1] === '=') continue;
    const pc = out[i - 1];
    if (code(i - 1) && (isWord(pc) || pc === ')' || pc === ']')) {
      const k = skipWsNoNl(i + 1);
      if (out[k] === '.' || out[k] === ')' || out[k] === ',' || out[k] === ';' || out[k] === ']' || out[k] === '[' || out[k] === '\n' || out[k] === '}' || out[k] === '?' || out[k] === ':' || k >= n) blank(i, i + 1);
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------- acorn

/** Parse a handler source file. Returns { ast, kind: 'esm'|'cjs', source, stripped }. Throws Ineligible. */
export function parseModule(source, { file = '' } = {}) {
  const ext = path.extname(file || '').toLowerCase();
  let text = source;
  let stripped = false;
  if (TS_EXTS.has(ext)) { text = stripTypes(source); stripped = true; }
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: false };
  let ast;
  let esmErr;
  try {
    ast = acorn.parse(text, { ...opts, sourceType: 'module' });
    return { ast, kind: hasEsmSyntax(ast) ? 'esm' : 'cjs', source, text, stripped };
  } catch (e) {
    esmErr = e;
  }
  try {
    ast = acorn.parse(text, { ...opts, sourceType: 'script' });
    return { ast, kind: 'cjs', source, text, stripped };
  } catch {
    const line = esmErr?.loc?.line ?? null;
    let hint = '';
    if (stripped) hint = ' (after TypeScript type stripping)';
    else if (ext === '.jsx' || ext === '.tsx') hint = ' (JSX is not supported in route handlers)';
    if (/\benum\b/.test(source)) hint += '; TypeScript enums are not supported, use a const object';
    throw new Ineligible(`parse error${hint}: ${esmErr.message.replace(/\s*\(\d+:\d+\)$/, '')}`, { file, line });
  }
}

function hasEsmSyntax(ast) {
  return ast.body.some((s) => s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
}

// ---------------------------------------------------------------- AST helpers

/** Visit every node (depth-first). `visit(node, parent)` returning false skips children. */
export function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'type' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, node); }
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

/** Names bound by a declaration pattern. */
export function patternNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern': for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out); break;
    case 'ArrayPattern': for (const el of p.elements) if (el) patternNames(el, out); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
    case 'RestElement': patternNames(p.argument, out); break;
    default: break;
  }
  return out;
}

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
export const isFunctionNode = (n) => !!n && FN_TYPES.has(n.type);

/**
 * Free identifiers of a function (referenced but not declared inside it),
 * with the AST node of the first reference. Property keys and member
 * property names are not references.
 */
export function freeVars(fnNode) {
  const declared = new Set();
  // params
  for (const p of fnNode.params) for (const nm of patternNames(p)) declared.add(nm);
  if (fnNode.id) declared.add(fnNode.id.name);
  // declarations inside (all scopes flattened: conservative — a name declared anywhere inside is "local")
  walk(fnNode.body, (n) => {
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) for (const nm of patternNames(d.id)) declared.add(nm);
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') { if (n.id) declared.add(n.id.name); }
    else if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') { for (const p of n.params) for (const nm of patternNames(p)) declared.add(nm); if (n.id) declared.add(n.id.name); }
    else if (n.type === 'CatchClause' && n.param) for (const nm of patternNames(n.param)) declared.add(nm);
  });
  const free = new Map();
  const visit = (n, parent) => {
    if (n.type === 'Identifier') {
      if (parent) {
        if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
        if (parent.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return;
        if (parent.type === 'Property' && parent.key === n && parent.shorthand && parent.value !== n) return;
        if (parent.type === 'MethodDefinition' && parent.key === n) return;
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
      }
      if (!declared.has(n.name) && !free.has(n.name)) free.set(n.name, n);
    }
  };
  for (const p of fnNode.params) walk(p, visit);
  walk(fnNode.body, visit);
  return free;
}

// ---------------------------------------------------------------- module shape

/**
 * Discover handlers, imports and module-scope declarations.
 * Returns { kind, ast, source, text, imports, handlers, decls, meta, sideEffects }.
 */
export function readModule(source, { file = '' } = {}) {
  const parsed = parseModule(source, { file });
  const { ast, kind } = parsed;
  const imports = [];
  const decls = new Map();      // name → { kind, node, init, line, exported }
  const handlers = { default: null, methods: {} };
  const meta = {};
  const sideEffects = [];
  const setDecl = (name, entry) => { if (!decls.has(name)) decls.set(name, entry); };
  const setMethod = (name, node, line) => { if (node) handlers.methods[name] = { node, line, name }; };
  const line = (n) => n?.loc?.start?.line ?? null;

  const registerVarDecl = (decl, exported = false) => {
    for (const d of decl.declarations) {
      // CommonJS require
      const req = requireSource(d.init);
      if (req) {
        const specs = [];
        if (d.id.type === 'Identifier') specs.push({ local: d.id.name, imported: req.member ?? '*' });
        else if (d.id.type === 'ObjectPattern') {
          for (const p of d.id.properties) {
            if (p.type === 'RestElement') continue;
            const imported = p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
            const local = p.value.type === 'Identifier' ? p.value.name : p.value.type === 'AssignmentPattern' && p.value.left.type === 'Identifier' ? p.value.left.name : null;
            if (local) specs.push({ local, imported });
          }
        }
        imports.push({ source: req.source, specifiers: specs, line: line(d) });
        continue;
      }
      if (d.id.type === 'Identifier') {
        setDecl(d.id.name, { kind: decl.kind, node: d, init: d.init, line: line(d), exported });
      } else {
        for (const nm of patternNames(d.id)) setDecl(nm, { kind: decl.kind, node: d, init: null, pattern: d.id, line: line(d), exported });
      }
    }
  };

  for (const s of ast.body) {
    switch (s.type) {
      case 'ImportDeclaration': {
        if (s.importKind === 'type') break;
        const specs = s.specifiers.map((sp) => ({
          local: sp.local.name,
          imported: sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' : (sp.imported.name ?? sp.imported.value),
        }));
        imports.push({ source: s.source.value, specifiers: specs, line: line(s) });
        break;
      }
      case 'ExportDefaultDeclaration': {
        handlers.default = { node: s.declaration, line: line(s), name: 'default' };
        if (s.declaration.type === 'FunctionDeclaration' && s.declaration.id) setDecl(s.declaration.id.name, { kind: 'function', node: s.declaration, line: line(s), exported: true });
        break;
      }
      case 'ExportNamedDeclaration': {
        if (s.declaration) {
          const d = s.declaration;
          if (d.type === 'FunctionDeclaration') {
            setDecl(d.id.name, { kind: 'function', node: d, line: line(d), exported: true });
            if (HTTP_METHODS.includes(d.id.name)) setMethod(d.id.name, d, line(d));
          } else if (d.type === 'VariableDeclaration') {
            registerVarDecl(d, true);
            for (const v of d.declarations) {
              if (v.id.type !== 'Identifier') continue;
              if (HTTP_METHODS.includes(v.id.name)) setMethod(v.id.name, v.init, line(v));
              else if (['config', 'runtime', 'dynamic', 'revalidate', 'maxDuration', 'preferredRegion', 'fetchCache', 'dynamicParams'].includes(v.id.name)) meta[v.id.name] = literalValue(v.init);
            }
          } else if (d.type === 'ClassDeclaration') {
            setDecl(d.id.name, { kind: 'class', node: d, line: line(d), exported: true });
          }
        } else {
          for (const sp of s.specifiers) {
            const exportedName = sp.exported.name ?? sp.exported.value;
            const localName = sp.local.name ?? sp.local.value;
            if (exportedName === 'default') handlers.default = { node: { type: 'Identifier', name: localName, loc: sp.loc }, line: line(sp), name: 'default' };
            else if (HTTP_METHODS.includes(exportedName)) setMethod(exportedName, { type: 'Identifier', name: localName, loc: sp.loc }, line(sp));
          }
        }
        break;
      }
      case 'ExportAllDeclaration': sideEffects.push({ node: s, what: 'export * from' }); break;
      case 'FunctionDeclaration': setDecl(s.id.name, { kind: 'function', node: s, line: line(s) }); break;
      case 'ClassDeclaration': setDecl(s.id.name, { kind: 'class', node: s, line: line(s) }); break;
      case 'VariableDeclaration': registerVarDecl(s); break;
      case 'ExpressionStatement': {
        const e = s.expression;
        // module.exports = X ; exports.X = Y ; module.exports.X = Y
        if (e.type === 'AssignmentExpression' && e.operator === '=') {
          const target = memberPath(e.left);
          if (target && (target[0] === 'module' && target[1] === 'exports' || target[0] === 'exports')) {
            const rest = target[0] === 'module' ? target.slice(2) : target.slice(1);
            if (rest.length === 0) {
              // module.exports = handler | { GET, POST }
              if (e.right.type === 'ObjectExpression') {
                for (const p of e.right.properties) {
                  if (p.type !== 'Property') continue;
                  const k = p.key.name ?? p.key.value;
                  if (k === 'default') handlers.default = { node: p.value, line: line(p), name: 'default' };
                  else if (HTTP_METHODS.includes(k)) setMethod(k, p.value, line(p));
                }
              } else handlers.default = { node: e.right, line: line(s), name: 'default' };
            } else if (rest.length === 1) {
              if (rest[0] === 'default') handlers.default = { node: e.right, line: line(s), name: 'default' };
              else if (HTTP_METHODS.includes(rest[0])) setMethod(rest[0], e.right, line(s));
              else if (rest[0] === 'config') meta.config = literalValue(e.right);
            }
            break;
          }
        }
        if (e.type === 'Literal' && typeof e.value === 'string') break; // 'use strict'
        sideEffects.push({ node: s, what: 'top-level statement' });
        break;
      }
      case 'EmptyStatement': break;
      default: sideEffects.push({ node: s, what: `top-level ${s.type}` });
    }
  }
  // record whether module-scope bindings are reassigned anywhere
  const reassigned = new Set();
  walk(ast, (n) => {
    if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') {
      const t = n.type === 'AssignmentExpression' ? n.left : n.argument;
      if (t.type === 'Identifier') reassigned.add(t.name);
      for (const nm of (t.type === 'ObjectPattern' || t.type === 'ArrayPattern') ? patternNames(t) : []) reassigned.add(nm);
    }
  });
  for (const [name, d] of decls) d.reassigned = reassigned.has(name);
  return { ...parsed, file, imports, handlers, decls, meta, sideEffects };
}

function memberPath(n) {
  const out = [];
  while (n) {
    if (n.type === 'Identifier') { out.unshift(n.name); return out; }
    if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') { out.unshift(n.property.name); n = n.object; continue; }
    if (n.type === 'MemberExpression' && n.computed && n.property.type === 'Literal') { out.unshift(String(n.property.value)); n = n.object; continue; }
    return null;
  }
  return null;
}

function requireSource(init) {
  if (!init) return null;
  if (init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require' && init.arguments[0]?.type === 'Literal') {
    return { source: String(init.arguments[0].value), member: null };
  }
  if (init.type === 'MemberExpression' && !init.computed && init.object.type === 'CallExpression') {
    const inner = requireSource(init.object);
    if (inner) return { source: inner.source, member: init.property.name };
  }
  return null;
}

/** Literal / plain-object value of a config export, or undefined. */
export function literalValue(n) {
  if (!n) return undefined;
  switch (n.type) {
    case 'Literal': return n.value;
    case 'TemplateLiteral': return n.expressions.length ? undefined : n.quasis.map((q) => q.value.cooked).join('');
    case 'ObjectExpression': {
      const o = {};
      for (const p of n.properties) { if (p.type !== 'Property') continue; o[p.key.name ?? p.key.value] = literalValue(p.value); }
      return o;
    }
    case 'ArrayExpression': return n.elements.map(literalValue);
    case 'UnaryExpression': return n.operator === '-' && n.argument.type === 'Literal' ? -n.argument.value : undefined;
    default: return undefined;
  }
}

/** Resolve a handler reference (identifier → its declaration's function node). */
export function resolveHandlerNode(ref, mod) {
  let node = ref?.node;
  if (!node) return null;
  if (node.type === 'Identifier') {
    const d = mod.decls.get(node.name);
    if (!d) throw new Ineligible(`handler \`${node.name}\` is exported but never declared in this file`, { file: mod.file, node });
    if (d.kind === 'function') return d.node;
    if (d.init && isFunctionNode(d.init)) return d.init;
    if (d.init?.type === 'CallExpression') throw new Ineligible(`handler \`${node.name}\` is wrapped in a call (${describeCallee(d.init)}); higher-order wrappers are not transmuted, export the plain handler`, { file: mod.file, node: d.init });
    throw new Ineligible(`handler \`${node.name}\` is not a function`, { file: mod.file, node: d.node });
  }
  if (isFunctionNode(node)) return node;
  if (node.type === 'CallExpression') throw new Ineligible(`the exported handler is wrapped in a call (${describeCallee(node)}); higher-order wrappers are not transmuted, export the plain handler`, { file: mod.file, node });
  throw new Ineligible(`the exported handler is a ${node.type}, not a function`, { file: mod.file, node });
}
function describeCallee(call) {
  const p = memberPath(call.callee);
  return p ? p.join('.') + '(...)' : 'call expression';
}
