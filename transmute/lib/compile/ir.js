// JS AST → IR.
//
// The IR is a small tree of Rust-shaped nodes: every expression yields an
// owned `Val`, statements are Rust statements, and the "specials" of the
// bridge (`req`, `res`, `request`, `params`, `kv`, `process.env`, ...) are
// resolved here into host calls so `rust.js` is a plain printer.
//
// Lowering is where eligibility is decided: anything outside the subset
// throws `Ineligible` with the offending `file:line`.
import {
  Ineligible, BANNED_GLOBALS, KNOWN_GLOBALS, RUNTIME_METHODS, CALLBACK_METHODS, MUTATING_METHODS, MATH_FUNCS, MATH_CONSTS,
  GLOBAL_FUNCS, KV_METHODS, bindImport,
} from '../eligibility.js';
import { HTTP_METHODS, walk, patternNames, freeVars, isFunctionNode, resolveHandlerNode } from './parse.js';

// ---------------------------------------------------------------- IR constructors

export const IR = {
  undef: () => ({ k: 'undef' }),
  null: () => ({ k: 'null' }),
  bool: (v) => ({ k: 'bool', v }),
  num: (v) => ({ k: 'num', v }),
  str: (v) => ({ k: 'str', v }),
  raw: (code) => ({ k: 'raw', code }),
  var: (name) => ({ k: 'var', name }),
  template: (parts) => ({ k: 'template', parts }),
  obj: (props) => ({ k: 'obj', props }),
  arr: (items) => ({ k: 'arr', items }),
  get: (obj, key) => ({ k: 'get', obj, key }),
  getc: (obj, key) => ({ k: 'getc', obj, key }),
  chain: (label, e) => ({ k: 'chain', label, e }),
  optcheck: (label, e) => ({ k: 'optcheck', label, e }),
  bin: (op, l, r) => ({ k: 'bin', op, l, r }),
  cmp: (op, l, r) => ({ k: 'cmp', op, l, r }),
  logical: (op, l, r) => ({ k: 'logical', op, l, r }),
  cond: (test, then, els) => ({ k: 'cond', test, then, else: els }),
  unary: (op, e) => ({ k: 'unary', op, e }),
  in: (key, obj) => ({ k: 'in', key, obj }),
  delete: (lv) => ({ k: 'delete', lv }),
  assign: (lv, value, op = null) => ({ k: 'assign', lv, value, op }),
  update: (lv, delta, prefix) => ({ k: 'update', lv, delta, prefix }),
  seq: (exprs) => ({ k: 'seq', exprs }),
  callm: (recv, lv, name, args, cb = null) => ({ k: 'callm', recv, lv, name, args, cb }),
  host: (fn, args = [], { q = false, void: v = false } = {}) => ({ k: 'host', fn, args, q, void: v }),
  pre: (stmts, e) => (stmts.length ? { k: 'pre', stmts, e } : e),
  math: (name, args) => ({ k: 'math', name, args }),
  global: (name, args) => ({ k: 'global', name, args }),
  jsonparse: (e) => ({ k: 'jsonparse', e }),
  jsonstringify: (e) => ({ k: 'jsonstringify', e }),
  keys: (e) => ({ k: 'keys', e }),
  values: (e) => ({ k: 'values', e }),
  entries: (e) => ({ k: 'entries', e }),
  isarray: (e) => ({ k: 'isarray', e }),
  newerror: (name, args) => ({ k: 'newerror', name, args }),
  log: (args) => ({ k: 'log', args }),
  helper: (name, args) => ({ k: 'helper', name, args }),
  resp: (kind, body, init) => ({ k: 'resp', kind, body, init }),
  params: (fn, paramsConst, name = null, catchAll = false) => ({ k: 'params', fn, paramsConst, name, catchAll }),
  callh: (name, args) => ({ k: 'callh', name, args }),
  constref: (name) => ({ k: 'constref', name }),
  iife: (fn, args) => ({ k: 'iife', fn, args }),
  // conditions
  truthy: (e) => (e.k === 'cmp' ? { k: 'c-cmp', op: e.op, l: e.l, r: e.r } : { k: 'c-truthy', e }),
  cnot: (c) => ({ k: 'c-not', c }),
  cand: (l, r) => ({ k: 'c-and', l, r }),
  cor: (l, r) => ({ k: 'c-or', l, r }),
  cnullish: (e) => ({ k: 'c-nullish', e }),
  // statements
  let: (name, init = null) => ({ k: 'let', name, init }),
  hoistvar: (name) => ({ k: 'hoistvar', name }),
  expr: (e) => ({ k: 'expr', e }),
  block: (body) => ({ k: 'block', body }),
  if: (test, then, els = null) => ({ k: 'if', test, then, else: els }),
  while: (label, test, body) => ({ k: 'while', label, test, body }),
  dowhile: (label, test, body) => ({ k: 'dowhile', label, test, body }),
  for: (label, init, test, update, body) => ({ k: 'for', label, init, test, update, body }),
  forof: (label, tmp, iter, body) => ({ k: 'forof', label, tmp, iter, body }),
  forin: (label, tmp, iter, body) => ({ k: 'forin', label, tmp, iter, body }),
  break: (label) => ({ k: 'break', label }),
  continue: (label) => ({ k: 'continue', label }),
  return: (mode, inTry, value = null) => ({ k: 'return', mode, inTry, value }),
  throw: (e) => ({ k: 'throw', e }),
  try: (body, param, handler, finalizer, mode, inTry) => ({ k: 'try', body, param, handler, finalizer, mode, inTry }),
  switch: (label, disc, cases) => ({ k: 'switch', label, disc, cases }),
  letfn: (name, fn, captures) => ({ k: 'letfn', name, fn, captures }),
  fn: (params, body) => ({ params, body }),
};

const SP = (t, extra = {}) => ({ t, ...extra });

// ---------------------------------------------------------------- naming

export function sanitizeIdent(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, (c) => (c === '$' ? '_S_' : '_u' + c.codePointAt(0).toString(16) + '_'));
}

// ---------------------------------------------------------------- scopes

class Scope {
  constructor(parent, { boundary = null, fn = null } = {}) {
    this.parent = parent;
    this.vars = new Map();
    this.boundary = boundary; // null | 'callback' | 'closure' | 'try' | 'fn'
    this.fn = fn || parent?.fn || null;
  }
  lookup(name) {
    const boundaries = [];
    for (let s = this; s; s = s.parent) {
      if (s.vars.has(name)) return { binding: s.vars.get(name), scope: s, boundaries };
      if (s.boundary) boundaries.push(s.boundary);
    }
    return null;
  }
  declare(name, binding) {
    this.vars.set(name, binding);
    return binding;
  }
}

/** Per-function lowering state. */
class FnCtx {
  constructor(retMode) {
    this.retMode = retMode; // 'node' | 'web' | 'value'
    this.tryDepth = 0;
    this.loops = []; // { label, isLoop, jsLabel } — 'marker' entries block break/continue across closures
    this.hoisted = new Set();
  }
}

// ---------------------------------------------------------------- the lowerer

export class Lowerer {
  constructor(mod, fn, opts = {}) {
    this.mod = mod;
    this.file = opts.file || mod.file;
    this.routeIndex = opts.index ?? 0;
    this.fnMeta = fn;
    this.params = (fn.params || []).map((p) => ({ name: p, catchAll: routeParamIsCatchAll(fn.routePath, p) }));
    this.paramsConst = `PARAMS_${this.routeIndex}`;
    this.tmp = 0;
    this.labelN = 0;
    this.chainN = 0;
    this.usesKv = false;
    this.env = new Set();
    this.envDynamic = false;
    this.warnings = [];
    this.helpers = []; // { name, fn }
    this.consts = []; // { name, e }
    this.moduleScope = new Scope(null, { boundary: 'fn' });
    this.moduleScope.fn = new FnCtx('value');
    this.nameCounts = new Map();
    this.pendingHelpers = [];
    this.setupModuleScope();
  }

  // ---- errors

  fail(reason, node) {
    throw new Ineligible(reason, { file: this.file, node });
  }
  warn(msg, node) {
    this.warnings.push(`${msg} (${this.file}${node?.loc ? ':' + node.loc.start.line : ''})`);
  }
  newTmp(prefix = '__t') {
    return `${prefix}${++this.tmp}`;
  }
  uniqueName(prefix, base) {
    const key = `${prefix}${sanitizeIdent(base)}`;
    const n = (this.nameCounts.get(key) || 0) + 1;
    this.nameCounts.set(key, n);
    return n === 1 ? key : `${key}_${n}`;
  }

  // ---- module scope

  setupModuleScope() {
    const ms = this.moduleScope;
    for (const imp of this.mod.imports) {
      const bound = bindImport(imp.source, imp.specifiers, { file: this.file, line: imp.line });
      for (const b of bound) {
        if (b.special) ms.declare(b.local, { kind: 'special', sp: b.special });
        else ms.declare(b.local, { kind: 'type-only', source: imp.source });
      }
    }
    for (const [name, d] of this.mod.decls) {
      if (ms.vars.has(name)) continue;
      if (d.kind === 'class') { ms.declare(name, { kind: 'class', node: d.node }); continue; }
      if (d.kind === 'function' || (d.init && isFunctionNode(d.init))) {
        ms.declare(name, { kind: 'helper', rust: this.uniqueName(`h_${this.routeIndex}_`, name), node: d.kind === 'function' ? d.node : d.init, lowered: false, name });
        continue;
      }
      ms.declare(name, { kind: 'modconst', decl: d, name, state: 'pending' });
    }
  }

  /** Resolve a module-scope binding on first use (lazy: only referenced helpers are emitted). */
  resolveModule(binding, node) {
    if (binding.kind === 'helper') {
      if (!binding.lowered) {
        binding.lowered = true;
        const fnIr = this.lowerFunctionBody(binding.node, this.moduleScope, 'value', { name: binding.name });
        this.helpers.push({ name: binding.rust, fn: fnIr });
      }
      return binding;
    }
    if (binding.kind === 'modconst') {
      const d = binding.decl;
      if (binding.state === 'lowering') this.fail(`module-level \`${binding.name}\` depends on itself`, node);
      if (binding.state === 'done') return binding.resolved;
      if (d.reassigned || d.kind !== 'const') {
        if (d.reassigned) this.fail(`module-level \`${binding.name}\` is reassigned: module state does not persist between invocations on chain; use @vercel/kv`, d.node);
      }
      if (d.pattern) this.fail(`destructuring at module scope (\`${binding.name}\`) is not supported; destructure inside the handler`, d.node);
      if (!d.init) this.fail(`module-level \`${binding.name}\` has no initializer`, d.node);
      binding.state = 'lowering';
      const saved = this.cur;
      this.cur = { scope: this.moduleScope, fn: this.moduleScope.fn, stmts: [] };
      let r;
      try {
        r = this.lowerExpr(d.init);
      } finally {
        this.cur = saved;
      }
      let resolved;
      if (r.special) {
        if (r.pre?.length) this.fail(`module-level \`${binding.name}\`: response calls at module scope are not allowed`, d.node);
        resolved = { kind: 'special', sp: r.special };
      } else {
        const rust = this.uniqueName(`c_${this.routeIndex}_`, binding.name);
        this.consts.push({ name: rust, e: r.ir });
        resolved = { kind: 'const', rust };
      }
      binding.state = 'done';
      binding.resolved = resolved;
      return resolved;
    }
    return binding;
  }

  // ---- entry points

  /** Lower a handler function node into an IR function. */
  lowerHandler(fnNode, style) {
    const retMode = style === 'node' ? 'node' : 'web';
    const specials = style === 'node' ? [SP('Req'), SP('Res')] : [SP('WebReq'), SP('ParamsCtx')];
    return this.lowerFunctionBody(fnNode, this.moduleScope, retMode, { paramSpecials: specials, name: 'handler' });
  }

  /**
   * Lower a function (handler, module helper, callback, local closure).
   * `paramSpecials` binds leading params to bridge specials instead of `__args`.
   */
  lowerFunctionBody(fnNode, parentScope, retMode, { paramSpecials = null, boundary = 'fn', name = null, captures = null } = {}) {
    if (fnNode.generator) this.fail('generator functions are not supported', fnNode);
    const fctx = new FnCtx(retMode);
    const scope = new Scope(parentScope, { boundary, fn: fctx });
    const saved = this.cur;
    const paramStmts = [];
    const bodyStmts = [];
    this.cur = { scope, fn: fctx, stmts: paramStmts };
    try {
      if (captures) for (const [jsName, b] of captures) scope.declare(jsName, b);
      fnNode.params.forEach((p, i) => {
        let pattern = p;
        let def = null;
        if (pattern.type === 'AssignmentPattern') { def = pattern.right; pattern = pattern.left; }
        if (pattern.type === 'RestElement') {
          if (paramSpecials) this.fail('rest parameters are not supported on handlers', p);
          this.bindPattern(pattern.argument, { ir: IR.helper('slice_from', [IR.raw('Val::Arr(__args.to_vec())'), IR.num(i)]) }, true, p);
          return;
        }
        if (paramSpecials && i < paramSpecials.length) {
          this.bindPattern(pattern, { special: paramSpecials[i] }, true, p);
          return;
        }
        if (paramSpecials) {
          // extra handler params (e.g. `next`) are undefined
          this.bindPattern(pattern, { ir: IR.undef() }, true, p);
          return;
        }
        let src = IR.raw(`__args.get(${i}).cloned().unwrap_or(Val::Undef)`);
        if (def) src = this.withDefault(src, def);
        this.bindPattern(pattern, { ir: src }, true, p);
      });
      this.cur.stmts = bodyStmts;
      if (fnNode.body.type === 'BlockStatement') {
        this.hoistVars(fnNode.body);
        this.lowerStatements(fnNode.body.body);
      } else {
        // expression-bodied arrow
        const r = this.lowerExpr(fnNode.body);
        this.emitReturn(r, fnNode.body);
      }
    } finally {
      this.cur = saved;
    }
    return { params: paramStmts, body: bodyStmts, name };
  }

  // ---- var hoisting

  hoistVars(block) {
    const names = [];
    const visit = (n) => {
      if (isFunctionNode(n)) return false;
      if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) names.push(...patternNames(d.id));
      return true;
    };
    walk(block, visit);
    for (const nm of names) {
      if (this.cur.scope.vars.has(nm)) continue;
      const rust = `v_${sanitizeIdent(nm)}`;
      this.cur.scope.declare(nm, { kind: 'local', rust, hoisted: true });
      this.cur.fn.hoisted.add(nm);
      this.cur.stmts.push(IR.hoistvar(rust));
    }
  }

  // ---- statements

  emit(stmt) {
    this.cur.stmts.push(stmt);
  }
  withScope(fnBody, { boundary = null } = {}) {
    const saved = this.cur;
    const stmts = [];
    this.cur = { scope: new Scope(saved.scope, { boundary }), fn: saved.fn, stmts };
    try { fnBody(); } finally { this.cur = saved; }
    return stmts;
  }
  lowerStatements(list) {
    for (const s of list) this.lowerStmt(s);
  }
  lowerBlock(node, opts) {
    const body = node.type === 'BlockStatement' ? node.body : [node];
    return this.withScope(() => this.lowerStatements(body), opts);
  }

  lowerStmt(node, jsLabel = null) {
    switch (node.type) {
      case 'VariableDeclaration': return this.lowerVarDecl(node);
      case 'FunctionDeclaration': return this.lowerLocalFunction(node.id.name, node, node);
      case 'ExpressionStatement': {
        const r = this.lowerExpr(node.expression);
        if (r.special) { for (const s of r.pre || []) this.emit(s); return; }
        this.emit(IR.expr(r.ir));
        return;
      }
      case 'ReturnStatement': {
        const r = node.argument ? this.lowerExpr(node.argument) : null;
        this.emitReturn(r, node);
        return;
      }
      case 'IfStatement': {
        const test = this.lowerCond(node.test);
        const then = this.lowerBlock(node.consequent);
        const els = node.alternate ? this.lowerBlock(node.alternate) : null;
        this.emit(IR.if(test, then, els));
        return;
      }
      case 'BlockStatement': this.emit(IR.block(this.lowerBlock(node))); return;
      case 'EmptyStatement': return;
      case 'DebuggerStatement': return;
      case 'LabeledStatement': {
        const b = node.body;
        if (['ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'BlockStatement'].includes(b.type)) return this.lowerStmt(b, node.label.name);
        this.fail('labeled statements are only supported on loops', node);
      }
      // eslint-disable-next-line no-fallthrough
      case 'WhileStatement': {
        const label = this.pushLoop(true, jsLabel);
        const test = this.lowerCond(node.test);
        const body = this.lowerBlock(node.body);
        this.popLoop();
        this.emit(IR.while(label, test, body));
        return;
      }
      case 'DoWhileStatement': {
        const label = this.pushLoop(true, jsLabel);
        const body = this.lowerBlock(node.body);
        const test = this.lowerCond(node.test);
        this.popLoop();
        this.emit(IR.dowhile(label, test, body));
        return;
      }
      case 'ForStatement': {
        const outer = this.withScope(() => {
          const init = [];
          if (node.init) {
            const saved = this.cur.stmts;
            this.cur.stmts = init;
            if (node.init.type === 'VariableDeclaration') this.lowerVarDecl(node.init);
            else { const r = this.lowerExpr(node.init); if (!r.special) this.emit(IR.expr(r.ir)); }
            this.cur.stmts = saved;
          }
          const label = this.pushLoop(true, jsLabel);
          const test = node.test ? this.lowerCond(node.test) : null;
          const body = this.lowerBlock(node.body);
          const update = [];
          if (node.update) {
            const saved = this.cur.stmts;
            this.cur.stmts = update;
            const r = this.lowerExpr(node.update);
            if (!r.special) this.emit(IR.expr(r.ir));
            this.cur.stmts = saved;
          }
          this.popLoop();
          this.emit(IR.for(label, init, test, update, body));
        });
        this.emit(IR.block(outer));
        return;
      }
      case 'ForOfStatement':
      case 'ForInStatement': {
        if (node.await) this.warn('for await: the await is dropped', node);
        const iter = this.val(this.lowerExpr(node.right), node.right);
        const label = this.pushLoop(true, jsLabel);
        const tmp = this.newTmp('__it');
        const body = this.withScope(() => {
          const left = node.left;
          if (left.type === 'VariableDeclaration') this.bindPattern(left.declarations[0].id, { ir: IR.var(tmp) }, true, left);
          else this.assignPattern(left, IR.var(tmp), left);
          const inner = node.body.type === 'BlockStatement' ? node.body.body : [node.body];
          this.lowerStatements(inner);
        });
        this.popLoop();
        this.emit(node.type === 'ForOfStatement' ? IR.forof(label, tmp, iter, body) : IR.forin(label, tmp, iter, body));
        return;
      }
      case 'BreakStatement': {
        const target = this.findLoop(node.label?.name ?? null, false, node);
        this.emit(IR.break(target.label));
        return;
      }
      case 'ContinueStatement': {
        const target = this.findLoop(node.label?.name ?? null, true, node);
        this.emit(IR.continue(target.label));
        return;
      }
      case 'ThrowStatement': this.emit(IR.throw(this.val(this.lowerExpr(node.argument), node.argument))); return;
      case 'TryStatement': return this.lowerTry(node);
      case 'SwitchStatement': return this.lowerSwitch(node, jsLabel);
      case 'ClassDeclaration': this.fail('classes are not supported on chain; use plain objects and functions', node); break;
      case 'WithStatement': this.fail('`with` is not supported', node); break;
      case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': this.fail('import/export inside a function body', node); break;
      default: this.fail(`unsupported statement: ${node.type}`, node);
    }
  }

  emitReturn(r, node) {
    const fn = this.cur.fn;
    const inTry = fn.tryDepth > 0;
    if (r && r.special) {
      for (const s of r.pre || []) this.emit(s);
      if (fn.retMode === 'value') {
        const m = this.materialize(r.special, node, true);
        if (!m) this.fail(`cannot return \`${describeSpecial(r.special)}\` from a helper`, node);
        this.emit(IR.return('value', inTry, m));
        return;
      }
      this.emit(IR.return(fn.retMode, inTry, null));
      return;
    }
    this.emit(IR.return(fn.retMode, inTry, r ? r.ir : null));
  }

  pushLoop(isLoop, jsLabel) {
    const label = `'l${this.labelN++}`;
    this.cur.fn.loops.push({ label, isLoop, jsLabel });
    return label;
  }
  popLoop() {
    this.cur.fn.loops.pop();
  }
  findLoop(jsLabel, needLoop, node) {
    const loops = this.cur.fn.loops;
    for (let i = loops.length - 1; i >= 0; i--) {
      const l = loops[i];
      if (l.marker) this.fail(`${needLoop ? 'continue' : 'break'} cannot cross a ${l.marker} boundary (move the loop inside, or the ${l.marker} outside)`, node);
      if (jsLabel ? l.jsLabel === jsLabel : (needLoop ? l.isLoop : true)) return l;
    }
    this.fail(`${needLoop ? 'continue' : 'break'} outside of a loop`, node);
  }
  /** Run `f` with loops blocked (inside a closure body). */
  withLoopMarker(marker, f) {
    const loops = this.cur.fn.loops;
    loops.push({ marker });
    try { return f(); } finally { loops.pop(); }
  }

  lowerVarDecl(node) {
    for (const d of node.declarations) {
      const id = d.id;
      // local function values: const f = (x) => ...
      if (id.type === 'Identifier' && d.init && isFunctionNode(d.init)) { this.lowerLocalFunction(id.name, d.init, d); continue; }
      const hoisted = node.kind === 'var';
      if (!d.init) {
        if (id.type === 'Identifier') {
          if (hoisted && this.cur.fn.hoisted.has(id.name) && this.cur.scope.lookup(id.name)?.binding.hoisted) continue;
          this.declareLocal(id.name, IR.undef(), d);
        } else this.fail('destructuring declaration without an initializer', d);
        continue;
      }
      const r = this.lowerExpr(d.init);
      this.bindPattern(id, r, !hoisted, d);
    }
  }

  declareLocal(jsName, initIr, node) {
    const rust = `v_${sanitizeIdent(jsName)}`;
    const existing = this.cur.scope.vars.get(jsName);
    if (existing && existing.hoisted) {
      this.emit(IR.expr(IR.assign({ k: 'lv-var', name: rust }, initIr)));
      return existing;
    }
    this.cur.scope.declare(jsName, { kind: 'local', rust });
    this.emit(IR.let(rust, initIr));
    return this.cur.scope.vars.get(jsName);
  }

  /**
   * Bind a declaration pattern to a lowering result (ir or special).
   * `declare` = true declares new locals; false assigns to existing ones.
   */
  bindPattern(pattern, r, declare, node) {
    if (r.special && r.pre?.length) { for (const s of r.pre) this.emit(s); r = { special: r.special }; }
    switch (pattern.type) {
      case 'Identifier': {
        if (r.special) {
          const sp = r.special;
          if (!declare) this.fail(`cannot assign \`${describeSpecial(sp)}\` to \`${pattern.name}\``, node);
          // plain constants become real values; bridge objects keep their methods
          if (sp.t === 'MathConst' || sp.t === 'ValueLike') { this.declareLocal(pattern.name, this.materialize(sp, node, true), node); return; }
          if (sp.t === 'Void') this.fail('this expression has no value (a response call)', node);
          this.cur.scope.declare(pattern.name, { kind: 'special', sp });
          return;
        }
        if (declare) this.declareLocal(pattern.name, r.ir, node);
        else this.emit(IR.expr(IR.assign(this.lvalueOfIdent(pattern.name, pattern), r.ir)));
        return;
      }
      case 'AssignmentPattern': {
        if (r.special) return this.bindPattern(pattern.left, r, declare, node);
        return this.bindPattern(pattern.left, { ir: this.withDefault(r.ir, pattern.right) }, declare, node);
      }
      case 'ObjectPattern': {
        if (r.special) {
          for (const p of pattern.properties) {
            if (p.type === 'RestElement') this.fail(`rest in destructuring of \`${describeSpecial(r.special)}\` is not supported`, p);
            const key = this.propKeyName(p);
            if (key === null) this.fail('computed keys in destructuring are not supported', p);
            const sub = this.memberOf(r.special, key, p, null);
            this.bindPattern(p.value, sub, declare, p);
          }
          return;
        }
        const tmp = this.newTmp('__d');
        this.emit(IR.let(tmp, r.ir));
        const used = [];
        for (const p of pattern.properties) {
          if (p.type === 'RestElement') {
            this.bindPattern(p.argument, { ir: IR.helper('omit', [IR.var(tmp), IR.arr(used.map((k) => ({ e: IR.str(k) })))]) }, declare, p);
            continue;
          }
          const key = this.propKeyName(p);
          if (key !== null) {
            used.push(key);
            this.bindPattern(p.value, { ir: IR.get(IR.var(tmp), key) }, declare, p);
          } else {
            const k = this.val(this.lowerExpr(p.key), p.key);
            this.bindPattern(p.value, { ir: IR.getc(IR.var(tmp), k) }, declare, p);
          }
        }
        return;
      }
      case 'ArrayPattern': {
        if (r.special) this.fail(`\`${describeSpecial(r.special)}\` is not iterable`, node);
        const tmp = this.newTmp('__d');
        this.emit(IR.let(tmp, r.ir));
        pattern.elements.forEach((el, i) => {
          if (!el) return;
          if (el.type === 'RestElement') { this.bindPattern(el.argument, { ir: IR.helper('slice_from', [IR.var(tmp), IR.num(i)]) }, declare, el); return; }
          this.bindPattern(el, { ir: IR.getc(IR.var(tmp), IR.num(i)) }, declare, el);
        });
        return;
      }
      case 'MemberExpression': {
        if (declare) this.fail('invalid declaration target', node);
        const lv = this.lowerLvalue(pattern);
        if (lv.k === 'lv-special') { for (const s of lv.set(r.ir)) this.emit(s); return; }
        this.emit(IR.expr(IR.assign(lv, this.val(r, node))));
        return;
      }
      default: this.fail(`unsupported binding pattern ${pattern.type}`, pattern);
    }
  }
  assignPattern(target, ir, node) {
    return this.bindPattern(target, { ir }, false, node);
  }
  propKeyName(p) {
    if (p.computed) return p.key.type === 'Literal' ? String(p.key.value) : null;
    return p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
  }
  withDefault(ir, defNode) {
    const def = this.val(this.lowerExpr(defNode), defNode);
    const t = this.newTmp();
    return IR.pre([IR.let(t, ir)], IR.cond({ k: 'c-undef', e: IR.var(t) }, def, IR.var(t)));
  }

  // ---- local functions

  lowerLocalFunction(jsName, fnNode, declNode) {
    // What does it capture from enclosing *local* scopes?
    const free = freeVars(fnNode);
    const captures = new Map();
    for (const [name, refNode] of free) {
      const found = this.cur.scope.lookup(name);
      if (!found) continue;
      if (found.scope === this.moduleScope) continue;
      const b = found.binding;
      if (b.kind === 'local') captures.set(name, b);
      else if (b.kind === 'localfn') captures.set(name, b);
      else if (b.kind === 'special') captures.set(name, b); // specials compile to cx calls: no capture needed, but keep visible
      else this.fail(`local function \`${jsName}\` references \`${name}\` which cannot be captured`, refNode);
    }
    const valueCaptures = [...captures].filter(([, b]) => b.kind !== 'special');
    if (valueCaptures.length === 0) {
      // No captures: a plain Rust fn (can recurse, can be used before definition is not supported).
      const rust = this.uniqueName(`h_${this.routeIndex}_`, jsName);
      const binding = { kind: 'helper', rust, node: fnNode, lowered: false, name: jsName };
      this.cur.scope.declare(jsName, binding);
      // helpers at module scope could reference this by name only if declared there; local ones lower now
      binding.lowered = true;
      // capture specials into the helper scope so `req`/`res` remain usable inside
      const specialCaptures = [...captures].filter(([, b]) => b.kind === 'special');
      const fnIr = this.lowerFunctionBody(fnNode, this.moduleScope, 'value', { name: jsName, captures: specialCaptures });
      this.helpers.push({ name: rust, fn: fnIr });
      return;
    }
    // Captures: a move closure over clones of the captured locals.
    const mutated = findMutation(fnNode, new Set(valueCaptures.map(([n]) => n)));
    if (mutated) this.fail(`local function \`${jsName}\` mutates captured variable \`${mutated}\`; captured variables are copied into closures on chain`, fnNode);
    const rust = this.uniqueName('f_', jsName);
    const binding = { kind: 'localfn', rust, name: jsName };
    const closureCaptures = new Map([...captures].map(([n, b]) => [n, b.kind === 'localfn' ? b : b.kind === 'local' ? { kind: 'local', rust: b.rust } : b]));
    const savedName = this.currentClosureName;
    this.currentClosureName = jsName;
    let fnIr;
    try {
      fnIr = this.lowerFunctionBody(fnNode, this.moduleScope, 'value', { name: jsName, boundary: 'closure', captures: closureCaptures });
    } finally {
      this.currentClosureName = savedName;
    }
    this.cur.scope.declare(jsName, binding);
    this.emit(IR.letfn(rust, fnIr, valueCaptures.map(([, b]) => b.rust)));
  }

  // ---- try / switch

  lowerTry(node) {
    const fn = this.cur.fn;
    const mode = fn.retMode;
    const inTry = fn.tryDepth > 0;
    fn.tryDepth++;
    let body;
    try {
      body = this.withLoopMarker('try', () => this.lowerBlock(node.block, { boundary: 'try' }));
    } finally {
      fn.tryDepth--;
    }
    let param = null;
    let handler = null;
    // With a `finally`, the catch handler is also a closure body so the
    // finalizer can run before any `return` it makes.
    const handlerClosure = !!node.finalizer;
    if (node.handler) {
      const lowerHandler = () => this.withScope(() => {
        if (node.handler.param) {
          if (node.handler.param.type === 'Identifier') {
            param = `v_${sanitizeIdent(node.handler.param.name)}`;
            this.cur.scope.declare(node.handler.param.name, { kind: 'local', rust: param });
          } else {
            param = this.newTmp('__e');
            this.bindPattern(node.handler.param, { ir: IR.var(param) }, true, node.handler);
          }
        }
        this.lowerStatements(node.handler.body.body);
      }, { boundary: handlerClosure ? 'try' : null });
      if (handlerClosure) {
        fn.tryDepth++;
        try { handler = this.withLoopMarker('try', lowerHandler); } finally { fn.tryDepth--; }
      } else handler = lowerHandler();
    }
    const finalizer = node.finalizer ? this.lowerBlock(node.finalizer) : null;
    this.emit({ ...IR.try(body, param, handler, finalizer, mode, inTry), handlerClosure });
  }

  lowerSwitch(node, jsLabel) {
    const disc = this.val(this.lowerExpr(node.discriminant), node.discriminant);
    const label = this.pushLoop(false, jsLabel);
    const cases = [];
    const outer = this.withScope(() => {
      for (const c of node.cases) {
        const test = c.test ? this.val(this.lowerExpr(c.test), c.test) : null;
        const body = this.withScope(() => this.lowerStatements(c.consequent));
        cases.push({ test, body });
      }
    });
    this.popLoop();
    this.emit(IR.block([...outer, IR.switch(label, disc, cases)]));
  }

  // ---- conditions

  lowerCond(node) {
    switch (node.type) {
      case 'UnaryExpression':
        if (node.operator === '!') return IR.cnot(this.lowerCond(node.argument));
        break;
      case 'LogicalExpression':
        if (node.operator === '&&') return IR.cand(this.lowerCond(node.left), this.lowerCond(node.right));
        if (node.operator === '||') return IR.cor(this.lowerCond(node.left), this.lowerCond(node.right));
        break;
      case 'BinaryExpression': {
        const op = CMP_OPS[node.operator];
        if (op) {
          const l = this.val(this.lowerExpr(node.left), node.left);
          const r = this.val(this.lowerExpr(node.right), node.right);
          return { k: 'c-cmp', op, l, r };
        }
        break;
      }
      default: break;
    }
    return IR.truthy(this.val(this.lowerExpr(node), node));
  }

  // ---- expressions

  /** Force a lowering result into a Val IR. */
  val(r, node) {
    if (!r.special) return r.ir;
    const m = this.materialize(r.special, node, false);
    if (!m) this.fail(`\`${describeSpecial(r.special)}\` cannot be used as a value here`, node);
    return IR.pre(r.pre || [], m);
  }

  materialize(sp, node, quiet) {
    switch (sp.t) {
      case 'ReqQuery': return IR.params('query', this.paramsConst);
      case 'ReqHeaders': case 'WebHeaders': return IR.host('req_headers');
      case 'Params': return IR.params('params', this.paramsConst);
      // as a value, URLSearchParams is an iterable of [key, value] pairs (Object.fromEntries / Array.from / for-of)
      case 'SearchParams': return IR.entries(IR.host('req_query'));
      case 'UrlObj': return IR.host('req_full_url');
      case 'DateNow': return IR.host('now_ms');
      case 'ProcessEnv': this.envDynamic = true; return IR.host('env_obj');
      case 'Cookies': return IR.helper('cookies', []);
      case 'MathConst': return IR.num(sp.v);
      case 'ValueLike': return sp.ir;
      default: return null;
    }
  }

  lowerExpr(node) {
    switch (node.type) {
      case 'Literal': return { ir: this.lowerLiteral(node) };
      case 'TemplateLiteral': {
        const parts = [];
        node.quasis.forEach((q, i) => {
          if (q.value.cooked) parts.push({ s: q.value.cooked });
          if (i < node.expressions.length) parts.push({ e: this.val(this.lowerExpr(node.expressions[i]), node.expressions[i]) });
        });
        return { ir: IR.template(parts) };
      }
      case 'TaggedTemplateExpression': this.fail('tagged templates are not supported', node); break;
      case 'Identifier': return this.lowerIdentifier(node);
      case 'ThisExpression': this.fail('`this` is not supported (no classes on chain)', node); break;
      case 'ArrayExpression': {
        const items = node.elements.map((el) => {
          if (!el) return { hole: true };
          if (el.type === 'SpreadElement') return { spread: this.val(this.lowerExpr(el.argument), el.argument) };
          return { e: this.val(this.lowerExpr(el), el) };
        });
        return { ir: IR.arr(items) };
      }
      case 'ObjectExpression': {
        const props = [];
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') { props.push({ spread: this.val(this.lowerExpr(p.argument), p.argument) }); continue; }
          if (p.kind !== 'init') this.fail('getters/setters in object literals are not supported', p);
          if (p.method || isFunctionNode(p.value)) this.fail('functions as object property values are not supported (functions are not first-class values on chain)', p);
          const key = this.propKeyName(p);
          const value = this.val(this.lowerExpr(p.value), p.value);
          if (key !== null) props.push({ key, value });
          else props.push({ key: { e: this.val(this.lowerExpr(p.key), p.key) }, value });
        }
        return { ir: IR.obj(props) };
      }
      case 'MemberExpression': return this.lowerMember(node, null);
      case 'ChainExpression': {
        const label = `'c${this.chainN++}`;
        const saved = this.chainLabel;
        this.chainLabel = { label, used: false };
        let r;
        try { r = this.lowerExpr(node.expression); } finally { this.chainLabel = saved; }
        if (r.special) return r;
        return { ir: IR.chain(label, r.ir) };
      }
      case 'CallExpression': return this.lowerCall(node);
      case 'NewExpression': return this.lowerNew(node);
      case 'AwaitExpression': return this.lowerExpr(node.argument);
      case 'UnaryExpression': return this.lowerUnary(node);
      case 'BinaryExpression': return this.lowerBinary(node);
      case 'LogicalExpression': {
        const l = this.val(this.lowerExpr(node.left), node.left);
        const r = this.val(this.lowerExpr(node.right), node.right);
        return { ir: IR.logical(node.operator === '&&' ? 'and' : node.operator === '||' ? 'or' : 'nullish', l, r) };
      }
      case 'ConditionalExpression': {
        const test = this.lowerCond(node.test);
        const a = this.lowerExpr(node.consequent);
        const b = this.lowerExpr(node.alternate);
        if (a.special || b.special) {
          // e.g. `cond ? res.status(200) : res.status(400)` — statements in both arms
          const sa = a.special ? (a.pre || []) : [IR.expr(a.ir)];
          const sb = b.special ? (b.pre || []) : [IR.expr(b.ir)];
          return { special: SP('Void'), pre: [IR.if(test, sa, sb)] };
        }
        return { ir: IR.cond(test, a.ir, b.ir) };
      }
      case 'AssignmentExpression': return this.lowerAssign(node);
      case 'UpdateExpression': {
        const lv = this.lowerLvalue(node.argument);
        if (lv.k === 'lv-special') this.fail('++/-- on a request/response property', node);
        return { ir: IR.update(lv, node.operator === '++' ? 1 : -1, node.prefix) };
      }
      case 'SequenceExpression': {
        const exprs = [];
        for (const e of node.expressions) exprs.push(this.val(this.lowerExpr(e), e));
        return { ir: IR.seq(exprs) };
      }
      case 'ArrowFunctionExpression': case 'FunctionExpression':
        this.fail('a function is used as a value; on chain functions can only be declared (`function f() {}` / `const f = () => {}`) and called or passed to array methods', node);
        break;
      case 'SpreadElement': this.fail('spread is only supported inside array and object literals', node); break;
      case 'YieldExpression': this.fail('generators are not supported', node); break;
      case 'ClassExpression': this.fail('classes are not supported on chain', node); break;
      case 'ImportExpression': this.fail('dynamic import() is not supported', node); break;
      case 'MetaProperty': this.fail('import.meta / new.target are not supported', node); break;
      case 'ParenthesizedExpression': return this.lowerExpr(node.expression);
      default: this.fail(`unsupported expression: ${node.type}`, node);
    }
    return null;
  }

  lowerLiteral(node) {
    if (node.regex) this.fail('regular expressions are not supported on chain (no RegExp engine in the runtime)', node);
    if (node.bigint !== undefined) this.fail('BigInt literals are not supported (numbers are f64)', node);
    const v = node.value;
    if (v === null) return IR.null();
    if (typeof v === 'string') return IR.str(v);
    if (typeof v === 'number') return IR.num(v);
    if (typeof v === 'boolean') return IR.bool(v);
    this.fail(`unsupported literal ${String(v)}`, node);
    return null;
  }

  lowerIdentifier(node) {
    const name = node.name;
    if (name === 'undefined') return { ir: IR.undef() };
    if (name === 'NaN') return { ir: IR.raw('Val::Num(f64::NAN)') };
    if (name === 'Infinity') return { ir: IR.raw('Val::Num(f64::INFINITY)') };
    if (name === 'arguments') this.fail('`arguments` is not supported; use rest parameters', node);
    const found = this.cur.scope.lookup(name);
    if (found) {
      let b = found.binding;
      if (found.scope === this.moduleScope) b = this.resolveModule(b, node);
      switch (b.kind) {
        case 'local': return { ir: IR.var(b.rust) };
        case 'special': return { special: b.sp };
        case 'const': return { ir: IR.constref(b.rust) };
        case 'helper': return { special: SP('HelperRef', { rust: b.rust, name }) };
        case 'localfn': return { special: SP('LocalFnRef', { rust: b.rust, name }) };
        case 'class': this.fail(`class \`${name}\`: classes are not supported on chain`, node); break;
        case 'type-only': this.fail(`\`${name}\` is a type import and has no runtime value`, node); break;
        default: this.fail(`cannot use \`${name}\` here`, node);
      }
    }
    if (name in BANNED_GLOBALS) this.fail(BANNED_GLOBALS[name], node);
    if (KNOWN_GLOBALS.has(name)) return { special: SP('Global', { name }) };
    if (this.currentClosureName === name) this.fail(`\`${name}\` is a recursive local function; move it to module scope`, node);
    this.fail(`unknown identifier \`${name}\` (not declared in this file, not imported, and not a supported global)`, node);
    return null;
  }

  lowerUnary(node) {
    const op = node.operator;
    if (op === 'typeof') {
      if (node.argument.type === 'Identifier') {
        const found = this.cur.scope.lookup(node.argument.name);
        if (!found && !KNOWN_GLOBALS.has(node.argument.name)) return { ir: IR.str(node.argument.name in BANNED_GLOBALS ? 'undefined' : 'undefined') };
        if (found && (found.binding.kind === 'helper' || found.binding.kind === 'localfn')) return { ir: IR.str('function') };
      }
      return { ir: IR.unary('typeof', this.val(this.lowerExpr(node.argument), node.argument)) };
    }
    if (op === 'delete') {
      if (node.argument.type !== 'MemberExpression') return { ir: IR.bool(true) };
      const lv = this.lowerLvalue(node.argument);
      if (lv.k === 'lv-special') this.fail('delete on a request/response property', node);
      return { ir: IR.delete(lv) };
    }
    if (op === 'void') return { ir: IR.unary('void', this.val(this.lowerExpr(node.argument), node.argument)) };
    if (op === '!') return { ir: IR.unary('not', this.lowerCond(node.argument)) };
    const e = this.val(this.lowerExpr(node.argument), node.argument);
    if (op === '-') { if (e.k === 'num') return { ir: IR.num(-e.v) }; return { ir: IR.unary('neg', e) }; }
    if (op === '+') return { ir: IR.unary('plus', e) };
    if (op === '~') return { ir: IR.unary('bitnot', e) };
    this.fail(`unsupported unary operator ${op}`, node);
    return null;
  }

  lowerBinary(node) {
    const op = node.operator;
    if (op === 'instanceof') this.fail('`instanceof` is not supported (no classes on chain)', node);
    if (op === 'in') {
      const key = this.val(this.lowerExpr(node.left), node.left);
      const obj = this.val(this.lowerExpr(node.right), node.right);
      return { ir: IR.in(key, obj) };
    }
    const l = this.val(this.lowerExpr(node.left), node.left);
    const r = this.val(this.lowerExpr(node.right), node.right);
    const cmp = CMP_OPS[op];
    if (cmp) return { ir: IR.cmp(cmp, l, r) };
    const bin = BIN_OPS[op];
    if (!bin) this.fail(`unsupported operator ${op}`, node);
    return { ir: IR.bin(bin, l, r) };
  }

  lowerAssign(node) {
    const op = node.operator;
    if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
      if (op !== '=') this.fail('compound assignment to a pattern', node);
      const tmp = this.newTmp('__d');
      const value = this.val(this.lowerExpr(node.right), node.right);
      const stmts = this.withScope(() => {
        this.emit(IR.let(tmp, value));
        this.assignPattern(node.left, IR.var(tmp), node);
      });
      return { ir: IR.pre(stmts, IR.var(tmp)) };
    }
    const lv = this.lowerLvalue(node.left);
    const value = this.val(this.lowerExpr(node.right), node.right);
    if (lv.k === 'lv-special') {
      if (op !== '=') this.fail('compound assignment to a response property', node);
      return { special: SP('Void'), pre: lv.set(value) };
    }
    if (op === '=') return { ir: IR.assign(lv, value) };
    if (op === '&&=' || op === '||=' || op === '??=') {
      const cur = this.readLvalue(lv);
      const logical = IR.logical(op === '&&=' ? 'and' : op === '||=' ? 'or' : 'nullish', cur, value);
      return { ir: IR.assign(lv, logical) };
    }
    const bin = BIN_OPS[op.slice(0, -1)];
    if (!bin) this.fail(`unsupported assignment operator ${op}`, node);
    return { ir: IR.assign(lv, value, bin) };
  }

  readLvalue(lv) {
    if (lv.k === 'lv-var') return IR.var(lv.name);
    if (lv.k === 'lv-member') {
      const base = lv.obj.k === 'lv-expr' ? lv.obj.e : this.readLvalue(lv.obj);
      return typeof lv.key === 'string' ? IR.get(base, lv.key) : IR.getc(base, lv.key);
    }
    return IR.undef();
  }

  lvalueOfIdent(name, node) {
    const found = this.cur.scope.lookup(name);
    if (!found) {
      if (name in BANNED_GLOBALS) this.fail(BANNED_GLOBALS[name], node);
      this.fail(`assignment to undeclared variable \`${name}\``, node);
    }
    if (found.scope === this.moduleScope) this.fail(`assignment to module-level \`${name}\`: module state does not persist between invocations on chain; use @vercel/kv`, node);
    const b = found.binding;
    if (b.kind !== 'local') this.fail(`cannot assign to \`${name}\` (${b.kind === 'special' ? describeSpecial(b.sp) : b.kind})`, node);
    if (found.boundaries.includes('closure')) this.fail(`\`${name}\` is captured by a local function and mutated inside it; captured variables are copied into closures on chain`, node);
    return { k: 'lv-var', name: b.rust };
  }

  lowerLvalue(node) {
    if (node.type === 'Identifier') return this.lvalueOfIdent(node.name, node);
    if (node.type === 'MemberExpression') {
      if (node.optional) this.fail('optional chaining on an assignment target', node);
      // res.statusCode = n
      const objR = node.object.type === 'Identifier' || node.object.type === 'MemberExpression' ? this.peekSpecial(node.object) : null;
      if (objR) {
        const key = node.computed ? (node.property.type === 'Literal' ? String(node.property.value) : null) : node.property.name;
        if (objR.t === 'Res' && key === 'statusCode') return { k: 'lv-special', set: (v) => [IR.expr(IR.host('res_status', [v], { void: true }))] };
        this.fail(`assignment to \`${describeSpecial(objR)}.${key ?? '[...]'}\` is not supported`, node);
      }
      let obj;
      if (node.object.type === 'Identifier' || node.object.type === 'MemberExpression') obj = this.lowerLvalue(node.object);
      else obj = { k: 'lv-expr', e: this.val(this.lowerExpr(node.object), node.object) };
      const key = node.computed ? (node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : this.val(this.lowerExpr(node.property), node.property)) : node.property.name;
      return { k: 'lv-member', obj, key };
    }
    if (node.type === 'ChainExpression') this.fail('optional chaining on an assignment target', node);
    this.fail(`unsupported assignment target ${node.type}`, node);
    return null;
  }

  /** If `node` resolves to a special without side effects, return it (no emission). */
  peekSpecial(node) {
    if (node.type === 'Identifier') {
      const found = this.cur.scope.lookup(node.name);
      if (found) {
        let b = found.binding;
        if (found.scope === this.moduleScope && b.kind === 'modconst') b = this.resolveModule(b, node);
        return b.kind === 'special' ? b.sp : null;
      }
      if (KNOWN_GLOBALS.has(node.name)) return SP('Global', { name: node.name });
      return null;
    }
    if (node.type === 'MemberExpression' && !node.computed) {
      const base = this.peekSpecial(node.object);
      if (!base) return null;
      const r = this.memberOf(base, node.property.name, node, null, true);
      return r?.special || null;
    }
    return null;
  }

  // ---- members

  lowerMember(node, callArgs) {
    const objR = this.lowerExpr(node.object);
    if (node.optional && !objR.special) {
      // a?.b — short-circuit the chain when the object is nullish
      const label = this.chainLabel;
      if (label) { label.used = true; objR.ir = IR.optcheck(label.label, objR.ir); }
    }
    let key;
    if (node.computed) {
      if (node.property.type === 'Literal' && typeof node.property.value === 'string') key = node.property.value;
      else if (node.property.type === 'Literal' && typeof node.property.value === 'number' && objR.special) key = String(node.property.value);
      else key = { e: this.val(this.lowerExpr(node.property), node.property) };
    } else key = node.property.name;
    if (objR.special) {
      if (typeof key === 'string') return this.memberOf(objR.special, key, node, callArgs, false, objR.pre);
      return this.computedMemberOf(objR.special, key.e, node, objR.pre);
    }
    return { ir: typeof key === 'string' ? IR.get(objR.ir, key) : IR.getc(objR.ir, key.e) };
  }

  computedMemberOf(sp, keyIr, node, pre = []) {
    switch (sp.t) {
      case 'ReqQuery': return { ir: IR.pre(pre, IR.getc(IR.params('query', this.paramsConst), keyIr)) };
      case 'ReqHeaders': return { ir: IR.pre(pre, IR.host('req_header', [keyIr])) };
      case 'ProcessEnv': this.envDynamic = true; return { ir: IR.pre(pre, IR.host('env', [keyIr])) };
      case 'Cookies': return { ir: IR.pre(pre, IR.getc(IR.helper('cookies', []), keyIr)) };
      case 'Params': return { ir: IR.pre(pre, IR.getc(IR.params('params', this.paramsConst), keyIr)) };
      default: {
        const m = this.materialize(sp, node, true);
        if (m) return { ir: IR.pre(pre, IR.getc(m, keyIr)) };
        this.fail(`computed property access on \`${describeSpecial(sp)}\` is not supported`, node);
      }
    }
    return null;
  }

  /**
   * `special.key` (and `special.key(...)` when callArgs is given). Returns a
   * lowering result. `quiet` = only resolve to specials, never emit/fail (for peeking).
   */
  memberOf(sp, key, node, callArgs, quiet = false, pre = []) {
    const isCall = callArgs !== null && callArgs !== undefined;
    const args = () => callArgs.map((a) => this.lowerArg(a));
    const arg = (i) => (callArgs[i] ? this.lowerArg(callArgs[i]) : IR.undef());
    const R = (ir) => ({ ir: IR.pre(pre, ir) });
    const S = (t, extra) => ({ special: SP(t, extra), pre });
    const notCall = () => { if (isCall) this.fail(`\`${describeSpecial(sp)}.${key}\` is not a function`, node); };
    const onlyCall = () => { if (!isCall) this.fail(`\`${describeSpecial(sp)}.${key}\` must be called`, node); };
    switch (sp.t) {
      case 'Req':
        switch (key) {
          case 'method': notCall(); return R(IR.host('req_method'));
          case 'url': notCall(); return R(IR.host('req_url'));
          case 'query': return S('ReqQuery');
          case 'body': notCall(); return R(IR.host('req_body'));
          case 'headers': return S('ReqHeaders');
          case 'cookies': return S('Cookies');
          case 'params': return S('Params');
          default: if (quiet) return null; this.fail(`req.${key} is not available on chain (supported: method, url, query, body, headers, cookies)`, node);
        }
        break;
      case 'ReqQuery': {
        if (quiet) return null;
        if (isCall) this.fail(`req.query.${key}(): req.query is a plain object`, node);
        return R(IR.get(IR.params('query', this.paramsConst), key));
      }
      case 'ReqHeaders': {
        if (quiet) return null;
        if (isCall) this.fail(`req.headers.${key}(): req.headers is a plain object`, node);
        return R(IR.host('req_header', [IR.str(key.toLowerCase())]));
      }
      case 'Cookies': {
        if (quiet) return null;
        return R(IR.get(IR.helper('cookies', []), key));
      }
      case 'Res': {
        if (quiet) return null;
        if (!isCall) {
          if (key === 'headersSent') return R(IR.bool(false));
          this.fail(`res.${key} is not supported as a value`, node);
        }
        const st = (ir) => ({ special: SP('Res'), pre: [...pre, IR.expr(ir)] });
        switch (key) {
          case 'status': return st(IR.host('res_status', [arg(0)], { void: true }));
          case 'json': return st(IR.host('res_json', [arg(0)], { void: true }));
          case 'send': return st(IR.host('res_send', [arg(0)], { void: true }));
          case 'end': return st(IR.host('res_end', [arg(0)], { void: true }));
          case 'setHeader': return st(IR.host('res_header', [arg(0), arg(1)], { void: true }));
          case 'redirect': return st(IR.host('res_redirect', [arg(0), arg(1)], { void: true }));
          case 'sendStatus': return { special: SP('Res'), pre: [...pre, IR.expr(IR.host('res_status', [arg(0)], { void: true })), IR.expr(IR.host('res_end', [IR.undef()], { void: true }))] };
          case 'writeHead': return { special: SP('Res'), pre: [...pre, IR.expr(IR.host('res_status', [arg(0)], { void: true })), ...(callArgs[1] ? [IR.expr(IR.helper('set_headers', [arg(1)]))] : [])] };
          case 'write': this.fail('res.write(): streaming responses are not supported; build the body and call res.send()/res.json() once', node); break;
          case 'getHeader': case 'removeHeader': case 'appendHeader': this.fail(`res.${key}() is not supported yet`, node); break;
          case 'cookie': case 'clearCookie': this.fail(`res.${key}() (Express helper) is not available; set a Set-Cookie header with res.setHeader`, node); break;
          default: this.fail(`res.${key}() is not a Vercel response helper the runtime supports (status, json, send, end, setHeader, redirect)`, node);
        }
        break;
      }
      case 'WebReq':
        switch (key) {
          case 'method': notCall(); return R(IR.host('req_method'));
          case 'url': notCall(); return R(IR.host('req_full_url'));
          case 'nextUrl': return S('UrlObj');
          case 'headers': return S('WebHeaders');
          case 'cookies': return S('WebCookies');
          case 'json': onlyCall(); return R(IR.host('req_json', [], { q: true }));
          case 'text': onlyCall(); return R(IR.host('req_text'));
          case 'clone': onlyCall(); return S('WebReq');
          case 'body': if (quiet) return null; this.fail('request.body is a stream; use `await request.json()` or `await request.text()`', node); break;
          case 'formData': if (quiet) return null; this.fail('request.formData() is not supported; send JSON', node); break;
          case 'arrayBuffer': case 'blob': case 'bytes': if (quiet) return null; this.fail(`request.${key}() is not supported; use request.text()`, node); break;
          case 'ip': case 'geo': if (quiet) return null; this.fail(`request.${key} is not available on chain`, node); break;
          case 'signal': if (quiet) return null; this.fail('request.signal is not available on chain', node); break;
          default: if (quiet) return null; this.fail(`request.${key} is not supported`, node);
        }
        break;
      case 'WebHeaders':
        if (quiet) return null;
        switch (key) {
          case 'get': onlyCall(); return R(IR.host('req_header', [arg(0)]));
          case 'has': onlyCall(); return R(IR.helper('header_has', [arg(0)]));
          default: this.fail(`request.headers.${key} is not supported (use .get(name) / .has(name))`, node);
        }
        break;
      case 'WebCookies':
        if (quiet) return null;
        switch (key) {
          case 'get': onlyCall(); return R(IR.helper('cookie_get', [arg(0)]));
          case 'has': onlyCall(); return R(IR.helper('cookie_has', [arg(0)]));
          case 'getAll': onlyCall(); return R(IR.helper('cookie_all', []));
          default: this.fail(`request.cookies.${key} is not supported (use .get(name) / .has(name) / .getAll())`, node);
        }
        break;
      case 'UrlObj':
        switch (key) {
          case 'searchParams': return S('SearchParams');
          case 'pathname': notCall(); return R(IR.host('req_path'));
          case 'search': notCall(); return R(IR.helper('search', [IR.bool(true)]));
          case 'href': notCall(); return R(IR.host('req_full_url'));
          case 'toString': onlyCall(); return R(IR.host('req_full_url'));
          case 'origin': notCall(); return R(IR.str('https://zoo.sol'));
          case 'host': case 'hostname': notCall(); return R(IR.str('zoo.sol'));
          case 'protocol': notCall(); return R(IR.str('https:'));
          case 'hash': notCall(); return R(IR.str(''));
          case 'basePath': notCall(); return R(IR.str(''));
          case 'clone': onlyCall(); return S('UrlObj');
          default: if (quiet) return null; this.fail(`URL.${key} is not supported`, node);
        }
        break;
      case 'SearchParams':
        if (quiet) return null;
        switch (key) {
          case 'get': onlyCall(); return R(IR.host('req_query_get', [arg(0)]));
          case 'has': onlyCall(); return R(IR.helper('query_has', [arg(0)]));
          case 'getAll': onlyCall(); return R(IR.helper('query_get_all', [arg(0)]));
          case 'toString': onlyCall(); return R(IR.helper('search', [IR.bool(false)]));
          case 'entries': onlyCall(); return R(IR.entries(IR.host('req_query')));
          case 'keys': onlyCall(); return R(IR.keys(IR.host('req_query')));
          case 'values': onlyCall(); return R(IR.values(IR.host('req_query')));
          case 'size': notCall(); return R(IR.get(IR.keys(IR.host('req_query')), 'length'));
          default: this.fail(`searchParams.${key} is not supported (use get/has/getAll/entries/keys/values/toString)`, node);
        }
        break;
      case 'ParamsCtx':
        if (key === 'params') return S('Params');
        if (quiet) return null;
        this.fail(`context.${key} is not supported (only context.params)`, node);
        break;
      case 'Params': {
        if (quiet) return null;
        if (isCall) this.fail('params is a plain object', node);
        const p = this.params.find((x) => x.name === key);
        if (!p) this.warn(`params.${key} is not a dynamic segment of ${this.fnMeta.routePath}; it will be undefined`, node);
        return R(IR.params('param', this.paramsConst, key, p ? p.catchAll : false));
      }
      case 'Kv': {
        if (quiet) return null;
        onlyCall();
        this.usesKv = true;
        const rt = KV_METHODS[key];
        if (!rt) this.fail(`kv.${key}() is not supported on chain (supported: ${Object.keys(KV_METHODS).join(', ')})`, node);
        const k = arg(0);
        switch (rt) {
          case 'kv_get': return R(IR.host('kv_get', [k], { q: true }));
          case 'kv_exists': return R(IR.host('kv_exists', [k], { q: true }));
          case 'kv_del': return R(IR.host('kv_del', [k], { q: true }));
          case 'kv_set': {
            if (callArgs.length > 2) this.warn('kv.set() options (ex/px/nx) are ignored: keys do not expire on chain', node);
            return R(IR.host('kv_set', [k, arg(1)], { q: true }));
          }
          case 'kv_incr': return R(IR.host('kv_incrby', [k, IR.num(1)], { q: true }));
          case 'kv_decr': return R(IR.host('kv_incrby', [k, IR.num(-1)], { q: true }));
          case 'kv_incrby': return R(IR.host('kv_incrby', [k, arg(1)], { q: true }));
          case 'kv_decrby': return R(IR.host('kv_incrby', [k, IR.unary('neg', arg(1))], { q: true }));
          default: break;
        }
        break;
      }
      case 'KvFactory': this.fail('createClient must be called: `const kv = createClient({...})`', node); break;
      case 'Namespace': {
        const bound = bindImport(sp.source, [{ local: key, imported: key }], { file: this.file, line: node.loc?.start.line });
        const b = bound[0];
        if (!b.special) { if (quiet) return null; this.fail(`\`${key}\` from ${sp.source} has no runtime value`, node); }
        if (isCall) return this.callSpecial(b.special, callArgs, node, pre);
        return { special: b.special, pre };
      }
      case 'NextResponse':
      case 'ResponseCls':
        if (quiet) return null;
        onlyCall();
        switch (key) {
          case 'json': return R(IR.resp('json', arg(0), arg(1)));
          case 'redirect': return R(IR.resp('redirect', arg(0), arg(1)));
          case 'rewrite': this.fail('NextResponse.rewrite() is a middleware/edge feature; not supported', node); break;
          case 'next': this.fail('NextResponse.next() is only meaningful in middleware', node); break;
          case 'error': return R(IR.resp('raw', IR.null(), IR.obj([{ key: 'status', value: IR.num(500) }])));
          default: this.fail(`${sp.t === 'NextResponse' ? 'NextResponse' : 'Response'}.${key}() is not supported (use json / redirect / new Response)`, node);
        }
        break;
      case 'DateNow':
        if (quiet) return null;
        onlyCall();
        switch (key) {
          case 'toISOString': case 'toJSON': return R(IR.host('now_iso'));
          case 'getTime': case 'valueOf': return R(IR.host('now_ms'));
          default: this.fail(`Date.${key}() is not supported on chain; only Date.now(), new Date().toISOString() and .getTime() are (there is no timezone database on chain)`, node);
        }
        break;
      case 'Global': return this.globalMember(sp.name, key, node, callArgs, quiet, pre);
      case 'Process':
        if (key === 'env') return S('ProcessEnv');
        if (quiet) return null;
        this.fail(`process.${key} is not available on chain`, node);
        break;
      case 'ProcessEnv': {
        if (quiet) return null;
        if (isCall) this.fail('process.env is a plain object', node);
        this.env.add(key);
        return R(IR.host('env', [IR.str(key)]));
      }
      case 'HelperRef': case 'LocalFnRef':
        if (quiet) return null;
        this.fail(`\`${sp.name}.${key}\`: functions have no properties on chain`, node);
        break;
      case 'MathConst': case 'ValueLike': {
        if (quiet) return null;
        const m = this.materialize(sp, node, true);
        if (isCall) return this.valMethodCall({ ir: m }, key, callArgs, node, null);
        return R(IR.get(m, key));
      }
      case 'Void':
        if (quiet) return null;
        this.fail('this expression has no value (a response call)', node);
        break;
      default:
        if (quiet) return null;
        this.fail(`\`${describeSpecial(sp)}.${key}\` is not supported`, node);
    }
    return null;
  }

  globalMember(g, key, node, callArgs, quiet, pre) {
    const isCall = callArgs !== null && callArgs !== undefined;
    const args = () => callArgs.map((a) => this.lowerArg(a));
    const arg = (i) => (callArgs[i] ? this.lowerArg(callArgs[i]) : IR.undef());
    const R = (ir) => ({ ir: IR.pre(pre, ir) });
    const S = (t, extra) => ({ special: SP(t, extra), pre });
    switch (g) {
      case 'Math':
        if (key === 'random') { if (quiet) return null; this.fail('Math.random() is nondeterministic: every validator must compute the same result, so randomness is not available on chain (derive it from the slot or a hash of the request instead)', node); }
        if (key in MATH_CONSTS) return S('MathConst', { v: MATH_CONSTS[key] });
        if (quiet) return null;
        if (!isCall) this.fail(`Math.${key} is not supported`, node);
        if (!MATH_FUNCS.has(key)) this.fail(`Math.${key}() is not supported by the on-chain runtime (supported: ${[...MATH_FUNCS].join(', ')})`, node);
        return R(IR.math(key, args()));
      case 'JSON':
        if (quiet) return null;
        if (!isCall) this.fail(`JSON.${key} must be called`, node);
        if (key === 'parse') return R(IR.jsonparse(arg(0)));
        if (key === 'stringify') { if (callArgs.length > 1) this.warn('JSON.stringify replacer/indent arguments are ignored', node); return R(IR.jsonstringify(arg(0))); }
        this.fail(`JSON.${key} is not supported`, node);
        break;
      case 'Object':
        if (quiet) return null;
        if (!isCall) this.fail(`Object.${key} must be called`, node);
        switch (key) {
          case 'keys': return R(IR.keys(arg(0)));
          case 'values': return R(IR.values(arg(0)));
          case 'entries': return R(IR.entries(arg(0)));
          case 'assign': return R(IR.helper('assign', args()));
          case 'fromEntries': return R(IR.helper('from_entries', [arg(0)]));
          case 'freeze': case 'seal': return R(arg(0));
          case 'hasOwn': return R(IR.in(arg(1), arg(0)));
          default: this.fail(`Object.${key}() is not supported (keys, values, entries, assign, fromEntries, hasOwn)`, node);
        }
        break;
      case 'Array':
        if (quiet) return null;
        if (!isCall) this.fail(`Array.${key} must be called`, node);
        if (key === 'isArray') return R(IR.isarray(arg(0)));
        if (key === 'from') { if (callArgs.length > 1) this.fail('Array.from(x, mapFn) is not supported; call .map() on the result', node); return R(IR.helper('array_from', [arg(0)])); }
        if (key === 'of') return R(IR.arr(args().map((e) => ({ e }))));
        this.fail(`Array.${key}() is not supported`, node);
        break;
      case 'Number':
        if (key === 'MAX_SAFE_INTEGER') return S('MathConst', { v: Number.MAX_SAFE_INTEGER });
        if (key === 'MIN_SAFE_INTEGER') return S('MathConst', { v: Number.MIN_SAFE_INTEGER });
        if (key === 'EPSILON') return S('MathConst', { v: Number.EPSILON });
        if (key === 'MAX_VALUE') return S('MathConst', { v: Number.MAX_VALUE });
        if (key === 'POSITIVE_INFINITY') return { ir: IR.raw('Val::Num(f64::INFINITY)'), pre };
        if (key === 'NEGATIVE_INFINITY') return { ir: IR.raw('Val::Num(f64::NEG_INFINITY)'), pre };
        if (key === 'NaN') return { ir: IR.raw('Val::Num(f64::NAN)'), pre };
        if (quiet) return null;
        if (!isCall) this.fail(`Number.${key} is not supported`, node);
        if (key === 'parseInt' || key === 'parseFloat') return R(IR.global(key, args()));
        if (['isInteger', 'isNaN', 'isFinite', 'isSafeInteger'].includes(key)) return R(IR.helper('num', [IR.str(key), arg(0)]));
        this.fail(`Number.${key}() is not supported`, node);
        break;
      case 'String':
        if (quiet) return null;
        this.fail(`String.${key}() is not supported`, node);
        break;
      case 'Promise':
        if (quiet) return null;
        if (!isCall) this.fail(`Promise.${key} is not supported`, node);
        if (key === 'all' || key === 'allSettled' || key === 'resolve') return R(arg(0));
        this.fail(`Promise.${key}() is not supported (everything is synchronous on chain)`, node);
        break;
      case 'Date':
        if (quiet) return null;
        if (!isCall) this.fail(`Date.${key} is not supported`, node);
        if (key === 'now') return R(IR.host('now_ms'));
        this.fail(`Date.${key}() is not supported on chain (only Date.now() and new Date().toISOString()/getTime())`, node);
        break;
      case 'console':
        if (quiet) return null;
        if (!isCall) this.fail('console must be called', node);
        if (['log', 'error', 'warn', 'info', 'debug', 'trace'].includes(key)) return R(IR.log(args()));
        return R(IR.undef());
      case 'process':
        if (key === 'env') return S('ProcessEnv');
        if (quiet) return null;
        this.fail(`process.${key} is not available on chain (only process.env)`, node);
        break;
      case 'Response': return this.memberOf(SP('ResponseCls'), key, node, callArgs, quiet, pre);
      case 'globalThis':
        if (quiet) return null;
        this.fail('globalThis is not supported', node);
        break;
      case 'Error': case 'TypeError': case 'RangeError': case 'SyntaxError':
        if (quiet) return null;
        this.fail(`${g}.${key} is not supported`, node);
        break;
      default:
        if (quiet) return null;
        this.fail(`\`${g}.${key}\` is not supported`, node);
    }
    return null;
  }

  // ---- calls

  lowerArg(node) {
    if (node.type === 'SpreadElement') this.fail('spread arguments are not supported', node);
    return this.val(this.lowerExpr(node), node);
  }

  lowerCall(node) {
    if (node.optional) this.fail('optional call `?.()` is not supported', node);
    const callee = node.callee;
    if (callee.type === 'MemberExpression') {
      // method call: special.method(...) or value.method(...)
      const objR = this.lowerExpr(callee.object);
      if (callee.optional && !objR.special) {
        const label = this.chainLabel;
        if (label) { label.used = true; objR.ir = IR.optcheck(label.label, objR.ir); }
      }
      let key;
      if (callee.computed) {
        if (callee.property.type === 'Literal' && typeof callee.property.value === 'string') key = callee.property.value;
        else this.fail('computed method calls `obj[name]()` are not supported', node);
      } else key = callee.property.name;
      if (objR.special) return this.memberOf(objR.special, key, node, node.arguments, false, objR.pre || []);
      const lv = this.lvalueIfPath(callee.object);
      return this.valMethodCall(objR, key, node.arguments, node, lv);
    }
    if (callee.type === 'Identifier') {
      const name = callee.name;
      const found = this.cur.scope.lookup(name);
      if (found) {
        let b = found.binding;
        if (found.scope === this.moduleScope) b = this.resolveModule(b, callee);
        if (b.kind === 'helper' || b.kind === 'localfn') return { ir: IR.callh(b.rust, node.arguments.map((a) => this.lowerArg(a))) };
        if (b.kind === 'special') return this.callSpecial(b.sp, node.arguments, node, []);
        if (b.kind === 'local') this.fail(`\`${name}\` is a value, not a function: functions are not first-class values on chain`, node);
        this.fail(`cannot call \`${name}\``, node);
      }
      if (name in BANNED_GLOBALS) this.fail(BANNED_GLOBALS[name], node);
      if (GLOBAL_FUNCS.has(name)) return { ir: IR.global(name, node.arguments.map((a) => this.lowerArg(a))) };
      if (name === 'Error' || name === 'TypeError' || name === 'RangeError' || name === 'SyntaxError') return { ir: IR.newerror(name, node.arguments.map((a) => this.lowerArg(a))) };
      if (name === 'Symbol') this.fail(BANNED_GLOBALS.Symbol, node);
      if (KNOWN_GLOBALS.has(name)) this.fail(`\`${name}()\` cannot be called directly`, node);
      this.fail(`call to unknown function \`${name}\` (not declared in this file, not imported)`, node);
    }
    if (isFunctionNode(callee)) {
      // IIFE
      const args = node.arguments.map((a) => this.lowerArg(a));
      const fnIr = this.withLoopMarker('closure', () => this.lowerFunctionBody(callee, this.cur.scope, 'value', { boundary: 'callback', name: 'iife' }));
      return { ir: IR.iife(fnIr, args) };
    }
    if (callee.type === 'ChainExpression') this.fail('optional call `?.()` is not supported', node);
    this.fail(`unsupported call target ${callee.type}`, node);
    return null;
  }

  callSpecial(sp, argNodes, node, pre) {
    switch (sp.t) {
      case 'KvFactory': this.usesKv = true; return { special: SP('Kv'), pre };
      case 'HelperRef': case 'LocalFnRef': return { ir: IR.pre(pre, IR.callh(sp.rust, argNodes.map((a) => this.lowerArg(a)))) };
      case 'Global': {
        const name = sp.name;
        if (GLOBAL_FUNCS.has(name)) return { ir: IR.pre(pre, IR.global(name, argNodes.map((a) => this.lowerArg(a)))) };
        if (['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(name)) return { ir: IR.pre(pre, IR.newerror(name, argNodes.map((a) => this.lowerArg(a)))) };
        this.fail(`\`${name}()\` cannot be called directly`, node);
        break;
      }
      default: this.fail(`\`${describeSpecial(sp)}\` is not callable`, node);
    }
    return null;
  }

  /** Is `node` an lvalue path rooted at a local variable? Returns the lv or null. */
  lvalueIfPath(node) {
    let n = node;
    while (n.type === 'MemberExpression') { if (n.optional) return null; n = n.object; }
    if (n.type !== 'Identifier') return null;
    const found = this.cur.scope.lookup(n.name);
    if (!found || found.binding.kind !== 'local' || found.scope === this.moduleScope) return null;
    if (found.boundaries.includes('closure')) return null;
    // build without side effects (member keys may have expressions — those are lowered again below, fine for pure keys)
    try {
      return this.lowerLvalue(node);
    } catch (e) {
      if (e instanceof Ineligible) return null;
      throw e;
    }
  }

  valMethodCall(objR, name, argNodes, node, lv) {
    const recv = objR.ir;
    if (CALLBACK_METHODS.has(name)) {
      const cbNode = argNodes[0];
      let cb = null;
      if (cbNode && isFunctionNode(cbNode)) {
        const fnIr = this.withLoopMarker('callback', () => this.lowerFunctionBody(cbNode, this.cur.scope, 'value', { boundary: 'callback', name }));
        cb = { kind: 'fn', fn: fnIr };
      } else if (cbNode && cbNode.type === 'Identifier') {
        const r = this.lowerExpr(cbNode);
        if (r.special && (r.special.t === 'HelperRef' || r.special.t === 'LocalFnRef')) cb = { kind: 'ref', name: r.special.rust };
        else this.fail(`.${name}() needs an inline function or a declared helper as its callback`, cbNode);
      } else if (cbNode || name !== 'sort') {
        this.fail(`.${name}() needs an inline function or a declared helper as its callback`, cbNode || node);
      }
      const rest = argNodes.slice(1).map((a) => this.lowerArg(a));
      if (name === 'sort' && !cb) cb = { kind: 'default-sort' };
      return { ir: IR.callm(recv, MUTATING_METHODS.has(name) ? lv : null, name, rest, cb) };
    }
    if (!RUNTIME_METHODS.has(name)) this.fail(`.${name}() is not implemented by the on-chain runtime`, node);
    for (const a of argNodes) if (isFunctionNode(a)) this.fail(`.${name}() with a function argument is not supported`, a);
    const args = argNodes.map((a) => this.lowerArg(a));
    return { ir: IR.callm(recv, MUTATING_METHODS.has(name) ? lv : null, name, args, null) };
  }

  lowerNew(node) {
    const callee = node.callee;
    const args = node.arguments;
    let sp = null;
    if (callee.type === 'Identifier') {
      const found = this.cur.scope.lookup(callee.name);
      if (found) {
        let b = found.binding;
        if (found.scope === this.moduleScope) b = this.resolveModule(b, callee);
        if (b.kind === 'special') sp = b.sp;
        else if (b.kind === 'class') this.fail('classes are not supported on chain', node);
        else this.fail(`\`new ${callee.name}\`: not a constructor`, node);
      } else if (callee.name in BANNED_GLOBALS) this.fail(BANNED_GLOBALS[callee.name], node);
      else if (KNOWN_GLOBALS.has(callee.name)) sp = SP('Global', { name: callee.name });
      else this.fail(`\`new ${callee.name}\`: unknown constructor`, node);
    } else if (callee.type === 'MemberExpression') {
      const r = this.peekSpecial(callee);
      if (r) sp = r;
      else this.fail('`new` on a computed constructor is not supported', node);
    } else this.fail('unsupported `new` target', node);
    const name = sp.t === 'Global' ? sp.name : sp.t;
    const arg = (i) => (args[i] ? this.lowerArg(args[i]) : IR.undef());
    switch (name) {
      case 'Response': case 'NextResponse': return { ir: IR.resp('raw', arg(0), arg(1)) };
      case 'URL': {
        // new URL(request.url [, base]) / new URL(req.url, base) → the request URL object
        const a0 = args[0];
        if (a0 && a0.type === 'MemberExpression') {
          const base = this.peekSpecial(a0.object);
          if (base && (base.t === 'WebReq' || base.t === 'Req') && !a0.computed && a0.property.name === 'url') return { special: SP('UrlObj') };
          if (base && base.t === 'WebReq' && !a0.computed && a0.property.name === 'nextUrl') return { special: SP('UrlObj') };
        }
        if (a0 && this.peekSpecial(a0)?.t === 'UrlObj') return { special: SP('UrlObj') };
        return { ir: IR.helper('url', [arg(0), arg(1)]) };
      }
      case 'Date':
        if (args.length === 0) return { special: SP('DateNow') };
        this.fail('new Date(value) is not supported on chain (no calendar/timezone library); only new Date() with toISOString()/getTime()', node);
        break;
      case 'Error': case 'TypeError': case 'RangeError': case 'SyntaxError':
        return { ir: IR.newerror(name, args.map((a) => this.lowerArg(a))) };
      case 'Promise': this.fail('new Promise() is not supported (everything is synchronous on chain)', node); break;
      case 'Object': return { ir: IR.obj([]) };
      case 'Array': if (args.length === 0) return { ir: IR.arr([]) }; this.fail('new Array(n) is not supported; use a literal', node); break;
      default: this.fail(`\`new ${name}\` is not supported`, node);
    }
    return null;
  }
}

// ---------------------------------------------------------------- tables & utils

const CMP_OPS = { '===': 'strict_eq', '!==': 'strict_ne', '==': 'loose_eq', '!=': 'loose_ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const BIN_OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem', '**': 'pow', '&': 'bit_and', '|': 'bit_or', '^': 'bit_xor', '<<': 'shl', '>>': 'shr', '>>>': 'ushr' };

function describeSpecial(sp) {
  switch (sp.t) {
    case 'Req': return 'req'; case 'Res': return 'res'; case 'WebReq': return 'request'; case 'ParamsCtx': return 'context';
    case 'Params': return 'params'; case 'SearchParams': return 'searchParams'; case 'UrlObj': return 'URL'; case 'Kv': return 'kv';
    case 'Global': return sp.name; case 'HelperRef': case 'LocalFnRef': return `function ${sp.name}`;
    default: return sp.t;
  }
}

function routeParamIsCatchAll(routePath, name) {
  if (!routePath) return false;
  return routePath.includes(`[...${name}]`) || routePath.includes(`[[...${name}]]`);
}

/** First captured name that the function body assigns to (any depth), or null. */
function findMutation(fnNode, names) {
  let found = null;
  walk(fnNode.body, (n) => {
    if (found) return false;
    if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') {
      let t = n.type === 'AssignmentExpression' ? n.left : n.argument;
      while (t.type === 'MemberExpression') t = t.object;
      if (t.type === 'Identifier' && names.has(t.name)) found = t.name;
      if (t.type === 'ObjectPattern' || t.type === 'ArrayPattern') for (const nm of patternNames(t)) if (names.has(nm)) found = nm;
    }
    return true;
  });
  return found;
}

// ---------------------------------------------------------------- route lowering

/**
 * Lower one Vercel function (a module) into a route IR.
 * @returns {{ ir: object, kv: boolean, env: string[], envDynamic: boolean, methods: string[]|null, style: 'node'|'web', warnings: string[] }}
 */
export function lowerRoute(mod, fn, { index = 0, file = mod.file } = {}) {
  const L = new Lowerer(mod, fn, { index, file });
  for (const s of mod.sideEffects) {
    L.fail(`${s.what} at module scope has side effects that cannot run on chain (module code runs once per Lambda instance; on chain there is no instance)`, s.node);
  }
  const route = { index, name: fn.name, file, params: L.params, paramsConst: L.paramsConst, style: null, node: null, methods: {}, helpers: L.helpers, consts: L.consts };
  const isNode = fn.style !== 'app' && !!mod.handlers.default;
  if (isNode) {
    const fnNode = resolveHandlerNode(mod.handlers.default, mod);
    route.style = 'node';
    route.node = L.lowerHandler(fnNode, 'node');
  } else {
    const names = Object.keys(mod.handlers.methods).filter((m) => HTTP_METHODS.includes(m));
    if (names.length === 0) {
      if (mod.handlers.default && fn.style === 'app') {
        L.fail('app-router route files export HTTP methods (GET, POST, ...); a default export is not a route handler', mod.handlers.default.node);
      }
      L.fail('no handler export found: expected `export default function (req, res)` or `export function GET/POST/...(request)`', mod.ast);
    }
    route.style = 'web';
    for (const m of names) {
      const fnNode = resolveHandlerNode(mod.handlers.methods[m], mod);
      route.methods[m] = L.lowerHandler(fnNode, 'web');
    }
  }
  return {
    ir: route,
    kv: L.usesKv,
    env: [...L.env],
    envDynamic: L.envDynamic,
    methods: route.style === 'web' ? Object.keys(route.methods) : null,
    style: route.style,
    warnings: L.warnings,
  };
}
