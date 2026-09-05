// IR → Rust source. A plain printer: every IR expression becomes a Rust
// expression of type `Val` (owned), statements become statements, and the
// crate skeleton wires routes into `zoo_host::dispatch`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RUNTIME_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime', 'zoo-host');

// ---------------------------------------------------------------- literals

export function rustStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

export function numLit(v) {
  if (Number.isNaN(v)) return 'f64::NAN';
  if (v === Infinity) return 'f64::INFINITY';
  if (v === -Infinity) return 'f64::NEG_INFINITY';
  if (Object.is(v, -0)) return '-0.0';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return `${v}.0`;
  let s = String(v);
  if (!/[.e]/.test(s)) s += '.0';
  return s;
}

/** Crate/package name; underscores only so the artifact is always `target/deploy/<name>.so`. */
export function sanitizeCrateName(name) {
  let n = String(name || 'zoo_site').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n || /^[0-9]/.test(n)) n = 'zoo_' + (n || 'site');
  return n;
}

// ---------------------------------------------------------------- printer

const IND = '    ';

export class RustPrinter {
  constructor() {
    this.tmp = 0;
  }
  t(prefix = '__x') {
    return `${prefix}${++this.tmp}`;
  }

  // ---- expressions

  E(ir) {
    switch (ir.k) {
      case 'undef': return 'Val::Undef';
      case 'null': return 'Val::Null';
      case 'bool': return `Val::Bool(${ir.v ? 'true' : 'false'})`;
      case 'num': return `Val::Num(${numLit(ir.v)})`;
      case 'str': return `Val::str(${rustStr(ir.v)})`;
      case 'raw': return ir.code;
      case 'var': return `${ir.name}.clone()`;
      case 'template': {
        const s = this.t('__s');
        const parts = ir.parts.map((p) => (p.s !== undefined ? `${s}.push_str(${rustStr(p.s)});` : `${s}.push_str(&(${this.E(p.e)}).to_js_string());`));
        return `Val::Str({ let mut ${s} = String::new(); ${parts.join(' ')} ${s} })`;
      }
      case 'obj': {
        const o = this.t('__o');
        const parts = ir.props.map((p) => {
          if (p.spread) { const kv = this.t('__kv'); return `if let Val::Obj(${kv}) = ${this.E(p.spread)} { for (__k, __v) in ${kv} { ${o}.set_str(&__k, __v); } }`; }
          if (typeof p.key === 'string') return `${o}.set_str(${rustStr(p.key)}, ${this.E(p.value)});`;
          const k = this.t('__k');
          return `{ let ${k} = ${this.E(p.key.e)}; let __v = ${this.E(p.value)}; ${o}.set(&${k}, __v); }`;
        });
        return `{ let mut ${o} = Val::obj(); ${parts.join(' ')} ${o} }`;
      }
      case 'arr': {
        if (!ir.items.some((i) => i.spread)) return `Val::Arr(alloc::vec![${ir.items.map((i) => (i.hole ? 'Val::Undef' : this.E(i.e))).join(', ')}])`;
        const a = this.t('__a');
        const parts = ir.items.map((i) => (i.spread ? `for __v in (${this.E(i.spread)}).iter_values() { ${a}.push(__v); }` : `${a}.push(${i.hole ? 'Val::Undef' : this.E(i.e)});`));
        return `{ let mut ${a} = Val::arr(); ${parts.join(' ')} ${a} }`;
      }
      case 'get': return `(${this.E(ir.obj)}).get_str(${rustStr(ir.key)})`;
      case 'getc': { const o = this.t('__o'); const k = this.t('__k'); return `{ let ${o} = ${this.E(ir.obj)}; let ${k} = ${this.E(ir.key)}; ${o}.get(&${k}) }`; }
      case 'chain': return `${ir.label}: { ${this.E(ir.e)} }`;
      case 'optcheck': { const t = this.t(); return `{ let ${t} = ${this.E(ir.e)}; if ${t}.is_nullish() { break ${ir.label} Val::Undef; } ${t} }`; }
      case 'bin': return `(${this.E(ir.l)}).${ir.op}(&(${this.E(ir.r)}))`;
      case 'cmp': return `Val::Bool(${this.cmp(ir.op, ir.l, ir.r)})`;
      case 'logical': {
        const t = this.t();
        const test = ir.op === 'and' ? `${t}.truthy()` : ir.op === 'or' ? `!${t}.truthy()` : `${t}.is_nullish()`;
        return `{ let ${t} = ${this.E(ir.l)}; if ${test} { ${this.E(ir.r)} } else { ${t} } }`;
      }
      case 'cond': return `if ${this.C(ir.test)} { ${this.E(ir.then)} } else { ${this.E(ir.else)} }`;
      case 'unary':
        switch (ir.op) {
          case 'neg': return `(${this.E(ir.e)}).neg()`;
          case 'plus': return `Val::Num((${this.E(ir.e)}).to_num())`;
          case 'not': return `Val::Bool(!(${this.C(ir.e)}))`;
          case 'bitnot': return `(${this.E(ir.e)}).bit_xor(&Val::Num(-1.0))`;
          case 'typeof': return `Val::str((${this.E(ir.e)}).type_of())`;
          case 'void': return `{ let _ = ${this.E(ir.e)}; Val::Undef }`;
          default: throw new Error(`unknown unary ${ir.op}`);
        }
      case 'in': { const k = this.t('__k'); const o = this.t('__o'); return `{ let ${k} = ${this.E(ir.key)}; let ${o} = ${this.E(ir.obj)}; Val::Bool(${o}.has(&${k})) }`; }
      case 'delete': {
        if (ir.lv.k !== 'lv-member') return 'Val::Bool(true)';
        const ctx = this.lvCtx(ir.lv);
        const keyExpr = this.keyRef(ir.lv, ctx);
        const stmts = this.rmw(ir.lv.obj, (base) => `${base}.delete(&${keyExpr});`, ctx);
        return `{ ${ctx.pre.join(' ')} ${stmts} Val::Bool(true) }`;
      }
      case 'assign': return this.assign(ir);
      case 'update': return this.update(ir);
      case 'seq': return `{ ${ir.exprs.slice(0, -1).map((e) => `let _ = ${this.E(e)};`).join(' ')} ${this.E(ir.exprs[ir.exprs.length - 1])} }`;
      case 'callm': return this.callm(ir);
      case 'host': {
        const q = ir.q ? '?' : '';
        if (!ir.args.length) return ir.void ? `{ cx.${ir.fn}(); Val::Undef }` : `cx.${ir.fn}()${q}`;
        const names = ir.args.map(() => this.t('__a'));
        const lets = ir.args.map((a, i) => `let ${names[i]} = ${this.E(a)};`).join(' ');
        const call = `cx.${ir.fn}(${names.map((n) => `&${n}`).join(', ')})${q}`;
        return ir.void ? `{ ${lets} ${call}; Val::Undef }` : `{ ${lets} ${call} }`;
      }
      case 'pre': return `{ ${ir.stmts.map((s) => this.S(s, '').join(' ')).join(' ')} ${this.E(ir.e)} }`;
      case 'math': return `{ ${this.argsVec(ir.args)} zv::math(${rustStr(ir.name)}, &__a)? }`;
      case 'global': return `{ ${this.argsVec(ir.args)} zv::global_call(${rustStr(ir.name)}, &__a)? }`;
      case 'jsonparse': return `{ let __s = ${this.E(ir.e)}; zjson::parse(&__s.to_js_string())? }`;
      case 'jsonstringify': return `{ let __v = ${this.E(ir.e)}; Val::Str(zjson::stringify(&__v)) }`;
      case 'keys': return `(${this.E(ir.e)}).keys()`;
      case 'values': return `(${this.E(ir.e)}).values()`;
      case 'entries': return `(${this.E(ir.e)}).entries()`;
      case 'isarray': return `Val::Bool(matches!(${this.E(ir.e)}, Val::Arr(_)))`;
      case 'newerror': {
        const name = ir.name === 'Error' ? '' : ` __e.set_str("name", Val::str(${rustStr(ir.name)}));`;
        return `{ ${this.argsVec(ir.args)} let mut __e = Ctx::new_error(&__a);${name} __e }`;
      }
      case 'log': return `{ ${this.argsVec(ir.args)} __zoo_log(cx, &__a); Val::Undef }`;
      case 'helper': return `{ ${this.argsVec(ir.args)} __zoo_${ir.name}(cx, &__a) }`;
      case 'resp': return `{ let __b = ${this.E(ir.body)}; let __i = ${this.E(ir.init)}; __zoo_resp(${rustStr(ir.kind)}, __b, __i) }`;
      case 'params':
        if (ir.fn === 'query') return `__zoo_query(cx, ${ir.paramsConst})`;
        if (ir.fn === 'params') return `__zoo_params(cx, ${ir.paramsConst})`;
        return `__zoo_param(cx, ${rustStr(ir.name)}, ${ir.catchAll ? 'true' : 'false'})`;
      case 'callh': return `{ ${this.argsVec(ir.args)} ${ir.name}(cx, &__a)? }`;
      case 'constref': return `${ir.name}(cx)?`;
      case 'iife': return `{ ${this.argsVec(ir.args)} let __args: &[Val] = &__a; (|| -> Result<Val, Val> {\n${this.fnBody(ir.fn, IND)}\n})()? }`;
      default: throw new Error(`unknown IR expression ${ir.k}`);
    }
  }

  argsVec(args) {
    return `let __a: Vec<Val> = alloc::vec![${args.map((a) => this.E(a)).join(', ')}];`;
  }

  cmp(op, l, r) {
    const L = this.E(l);
    const R = this.E(r);
    switch (op) {
      case 'strict_eq': return `(${L}).strict_eq(&(${R}))`;
      case 'strict_ne': return `!(${L}).strict_eq(&(${R}))`;
      case 'loose_eq': return `(${L}).loose_eq(&(${R}))`;
      case 'loose_ne': return `!(${L}).loose_eq(&(${R}))`;
      default: return `(${L}).${op}(&(${R}))`;
    }
  }

  // ---- conditions

  C(c) {
    switch (c.k) {
      case 'c-truthy': return `(${this.E(c.e)}).truthy()`;
      case 'c-not': return `!(${this.C(c.c)})`;
      case 'c-and': return `(${this.C(c.l)} && ${this.C(c.r)})`;
      case 'c-or': return `(${this.C(c.l)} || ${this.C(c.r)})`;
      case 'c-cmp': return this.cmp(c.op, c.l, c.r);
      case 'c-nullish': return `(${this.E(c.e)}).is_nullish()`;
      case 'c-undef': return `(${this.E(c.e)}).is_undef()`;
      default: throw new Error(`unknown condition ${c.k}`);
    }
  }

  // ---- lvalues

  /**
   * An lvalue "operation context": computed keys of the path are evaluated
   * once, left to right, into temps (`pre`), so reads and writes of the same
   * path agree. Fresh per assignment/update/call — never cached on the IR.
   */
  lvCtx(lv) {
    const ctx = { pre: [], keys: new Map() };
    const hoist = (x) => {
      if (x.k !== 'lv-member') return;
      hoist(x.obj);
      if (typeof x.key !== 'string') { const t = this.t('__k'); ctx.keys.set(x, t); ctx.pre.push(`let ${t} = ${this.E(x.key)};`); }
    };
    hoist(lv);
    return ctx;
  }
  keyRef(lv, ctx) {
    if (typeof lv.key === 'string') return `Val::str(${rustStr(lv.key)})`;
    return ctx.keys.get(lv);
  }
  readLv(lv, ctx) {
    if (lv.k === 'lv-var') return `${lv.name}.clone()`;
    if (lv.k === 'lv-expr') return this.E(lv.e);
    const base = this.readLv(lv.obj, ctx);
    if (typeof lv.key === 'string') return `(${base}).get_str(${rustStr(lv.key)})`;
    return `(${base}).get(&${this.keyRef(lv, ctx)})`;
  }
  /** Read-modify-write: `mut(place)` receives the name of a mutable Val binding. */
  rmw(lv, mut, ctx) {
    if (lv.k === 'lv-var') return mut(lv.name);
    if (lv.k === 'lv-expr') { const t = this.t('__m'); return `{ let mut ${t} = ${this.E(lv.e)}; ${mut(t)} }`; }
    return this.rmw(lv.obj, (base) => {
      const t = this.t('__m');
      const key = this.keyRef(lv, ctx);
      const getter = typeof lv.key === 'string' ? `get_str(${rustStr(lv.key)})` : `get(&${key})`;
      const setter = typeof lv.key === 'string' ? `set_str(${rustStr(lv.key)}, ${t})` : `set(&${key}, ${t})`;
      return `{ let mut ${t} = ${base}.${getter}; ${mut(t)} ${base}.${setter}; }`;
    }, ctx);
  }
  writeLv(lv, valueExpr, ctx) {
    if (lv.k === 'lv-var') return `${lv.name} = ${valueExpr};`;
    if (lv.k === 'lv-expr') return `{ let _ = ${valueExpr}; }`;
    return this.rmw(lv.obj, (base) => {
      if (typeof lv.key === 'string') return `${base}.set_str(${rustStr(lv.key)}, ${valueExpr});`;
      return `${base}.set(&${this.keyRef(lv, ctx)}, ${valueExpr});`;
    }, ctx);
  }
  assign(ir) {
    const ctx = this.lvCtx(ir.lv);
    const v = this.t('__v');
    let valueExpr = this.E(ir.value);
    if (ir.op) valueExpr = `(${this.readLv(ir.lv, ctx)}).${ir.op}(&(${valueExpr}))`;
    const write = this.writeLv(ir.lv, `${v}.clone()`, ctx);
    return `{ ${ctx.pre.join(' ')} let ${v} = ${valueExpr}; ${write} ${v} }`;
  }
  update(ir) {
    const ctx = this.lvCtx(ir.lv);
    const cur = this.readLv(ir.lv, ctx);
    const o = this.t('__old');
    const n = this.t('__new');
    const write = this.writeLv(ir.lv, `${n}.clone()`, ctx);
    const delta = ir.delta > 0 ? '+ 1.0' : '- 1.0';
    return `{ ${ctx.pre.join(' ')} let ${o} = Val::Num((${cur}).to_num()); let ${n} = Val::Num(${o}.to_num() ${delta}); ${write} ${ir.prefix ? n : o} }`;
  }

  // ---- method calls

  callm(ir) {
    const parts = [];
    const r = this.t('__r');
    if (!ir.lv) parts.push(`let mut ${r} = ${this.E(ir.recv)};`);
    parts.push(this.argsVec(ir.args));
    let cbArg = 'None';
    let errCheck = '';
    if (ir.cb) {
      const f = this.t('__f');
      const err = this.t('__err');
      parts.push(`let mut ${err}: Option<Val> = None;`);
      if (ir.cb.kind === 'fn') {
        parts.push(`let mut ${f} = |__args: &[Val]| -> Val { let __res: Result<Val, Val> = (|| -> Result<Val, Val> {\n${this.fnBody(ir.cb.fn, IND)}\n})(); match __res { Ok(__v) => __v, Err(__e) => { ${err} = Some(__e); Val::Undef } } };`);
      } else if (ir.cb.kind === 'ref') {
        parts.push(`let mut ${f} = |__args: &[Val]| -> Val { match ${ir.cb.name}(cx, __args) { Ok(__v) => __v, Err(__e) => { ${err} = Some(__e); Val::Undef } } };`);
      } else {
        parts.push(`let mut ${f} = |__args: &[Val]| -> Val { let __x = __args.get(0).map(|v| v.to_js_string()).unwrap_or_default(); let __y = __args.get(1).map(|v| v.to_js_string()).unwrap_or_default(); Val::Num(if __x < __y { -1.0 } else if __x > __y { 1.0 } else { 0.0 }) };`);
      }
      cbArg = `Some(&mut ${f})`;
      errCheck = ` if let Some(__e) = ${err} { return Err(__e); }`;
    }
    const out = this.t('__out');
    if (ir.lv) {
      const ctx = this.lvCtx(ir.lv);
      const stmts = this.rmw(ir.lv, (place) => `${out} = ${place}.call(${rustStr(ir.name)}, &__a, ${cbArg});`, ctx);
      parts.push(`${ctx.pre.join(' ')} let mut ${out}: Result<Val, Val> = Ok(Val::Undef); ${stmts}`);
    } else {
      parts.push(`let ${out} = ${r}.call(${rustStr(ir.name)}, &__a, ${cbArg});`);
    }
    return `{ ${parts.join(' ')}${errCheck} ${out}? }`;
  }

  // ---- statements

  S(s, ind) {
    const L = (x) => `${ind}${x}`;
    switch (s.k) {
      case 'let': return [L(`let mut ${s.name}: Val = ${s.init ? this.E(s.init) : 'Val::Undef'};`)];
      case 'hoistvar': return [L(`let mut ${s.name}: Val = Val::Undef;`)];
      case 'expr': return [L(`let _ = ${this.E(s.e)};`)];
      case 'block': return [L('{'), ...this.body(s.body, ind + IND), L('}')];
      case 'if': {
        const out = [L(`if ${this.C(s.test)} {`), ...this.body(s.then, ind + IND)];
        if (s.else) out.push(L('} else {'), ...this.body(s.else, ind + IND));
        out.push(L('}'));
        return out;
      }
      case 'while': return [L(`${s.label}: while ${this.C(s.test)} {`), ...this.body(s.body, ind + IND), L('}')];
      case 'dowhile': {
        const f = this.t('__first');
        return [L('{'), L(`${IND}let mut ${f} = true;`), L(`${IND}${s.label}: while ${f} || ${this.C(s.test)} {`), L(`${IND}${IND}${f} = false;`), ...this.body(s.body, ind + IND + IND), L(`${IND}}`), L('}')];
      }
      case 'for': {
        const f = this.t('__first');
        const out = [L('{'), ...this.body(s.init, ind + IND), L(`${IND}let mut ${f} = true;`), L(`${IND}${s.label}: loop {`)];
        if (s.update.length) out.push(L(`${IND}${IND}if !${f} {`), ...this.body(s.update, ind + IND + IND + IND), L(`${IND}${IND}}`));
        out.push(L(`${IND}${IND}${f} = false;`));
        if (s.test) out.push(L(`${IND}${IND}if !(${this.C(s.test)}) { break; }`));
        out.push(...this.body(s.body, ind + IND + IND), L(`${IND}}`), L('}'));
        return out;
      }
      case 'forof': return [L(`${s.label}: for ${s.tmp} in (${this.E(s.iter)}).iter_values() {`), ...this.body(s.body, ind + IND), L('}')];
      case 'forin': return [L(`${s.label}: for ${s.tmp} in (${this.E(s.iter)}).keys().iter_values() {`), ...this.body(s.body, ind + IND), L('}')];
      case 'break': return [L(`break ${s.label};`)];
      case 'continue': return [L(`continue ${s.label};`)];
      case 'return': return this.ret(s, ind);
      case 'throw': return [L(`return Err(${this.E(s.e)});`)];
      case 'try': return this.tryStmt(s, ind);
      case 'switch': {
        const d = this.t('__d');
        const idx = this.t('__idx');
        const out = [L('{'), L(`${IND}let ${d} = ${this.E(s.disc)};`)];
        let defaultIdx = -1;
        const chain = [];
        s.cases.forEach((c, i) => {
          if (c.test === null) { defaultIdx = i; return; }
          chain.push(`if ${d}.strict_eq(&(${this.E(c.test)})) { ${i} }`);
        });
        out.push(L(`${IND}let ${idx}: i32 = ${chain.length ? chain.join(' else ') + ' else ' : ''}{ ${defaultIdx} };`));
        out.push(L(`${IND}${s.label}: loop {`));
        s.cases.forEach((c, i) => {
          out.push(L(`${IND}${IND}if ${idx} >= 0 && ${idx} <= ${i} {`), ...this.body(c.body, ind + IND + IND + IND), L(`${IND}${IND}}`));
        });
        out.push(L(`${IND}${IND}break;`), L(`${IND}}`), L('}'));
        return out;
      }
      case 'letfn': {
        const caps = s.captures.map((c) => `let ${c} = ${c}.clone();`).join(' ');
        return [L(`let ${s.name} = { ${caps} move |cx: &mut Ctx, __args: &[Val]| -> Result<Val, Val> {`), ...this.fnBodyLines(s.fn, ind + IND), L('} };')];
      }
      default: throw new Error(`unknown IR statement ${s.k}`);
    }
  }

  body(stmts, ind) {
    const out = [];
    for (const s of stmts) out.push(...this.S(s, ind));
    return out;
  }

  ret(s, ind) {
    const L = (x) => `${ind}${x}`;
    const val = s.value ? this.E(s.value) : 'Val::Undef';
    switch (s.mode) {
      case 'node': {
        const out = [];
        if (s.value) out.push(L(`{ let _ = ${val}; }`));
        out.push(L(s.inTry ? 'return Ok(Some(Val::Undef));' : 'return Ok(());'));
        return out;
      }
      case 'web':
        if (s.inTry) return [L(`return Ok(Some(${val}));`)];
        if (!s.value) return [L('return Ok(());')];
        return [L(`{ let __rv = ${val}; __zoo_send(cx, &__rv)?; }`), L('return Ok(());')];
      case 'value':
        return [L(s.inTry ? `return Ok(Some(${val}));` : `return Ok(${val});`)];
      default: throw new Error(`unknown return mode ${s.mode}`);
    }
  }

  /** What to do after a try body returned `Some(rv)`. */
  retFromTry(mode, inTry, ind) {
    const L = (x) => `${ind}${x}`;
    if (inTry) return [L('return Ok(Some(__rv));')];
    if (mode === 'node') return [L('return Ok(());')];
    if (mode === 'web') return [L('__zoo_send(cx, &__rv)?;'), L('return Ok(());')];
    return [L('return Ok(__rv);')];
  }

  tryStmt(s, ind) {
    const L = (x) => `${ind}${x}`;
    const r = this.t('__tr');
    const out = [L(`let ${r}: Result<Option<Val>, Val> = (|| -> Result<Option<Val>, Val> {`), ...this.body(s.body, ind + IND), L(`${IND}Ok(None)`), L('})();')];
    if (s.handlerClosure) {
      // try { } catch { } finally { }: the handler runs as a closure too, then the
      // finalizer, then the outcome (return / rethrow / fall through) is applied.
      const r2 = this.t('__tr');
      if (s.handler) {
        out.push(L(`let ${r2}: Result<Option<Val>, Val> = match ${r} {`));
        out.push(L(`${IND}Err(__e) => (|| -> Result<Option<Val>, Val> {`));
        if (s.param) out.push(L(`${IND}${IND}let mut ${s.param}: Val = __zoo_caught(__e);`));
        out.push(...this.body(s.handler, ind + IND + IND), L(`${IND}${IND}Ok(None)`), L(`${IND}})(),`));
        out.push(L(`${IND}__other => __other,`), L('};'));
      } else {
        out.push(L(`let ${r2}: Result<Option<Val>, Val> = ${r};`));
      }
      if (s.finalizer) out.push(...this.body(s.finalizer, ind));
      out.push(L(`match ${r2} {`));
      out.push(L(`${IND}Ok(None) => {}`));
      out.push(L(`${IND}Ok(Some(__rv)) => {`), ...this.retFromTry(s.mode, s.inTry, ind + IND + IND), L(`${IND}}`));
      out.push(L(`${IND}Err(__e) => { return Err(__e); }`));
      out.push(L('}'));
      return out;
    }
    out.push(L(`match ${r} {`));
    out.push(L(`${IND}Ok(None) => {}`));
    out.push(L(`${IND}Ok(Some(__rv)) => {`), ...(s.finalizer ? this.body(s.finalizer, ind + IND + IND) : []), ...this.retFromTry(s.mode, s.inTry, ind + IND + IND), L(`${IND}}`));
    if (s.handler) {
      out.push(L(`${IND}Err(__e) => {`));
      if (s.param) out.push(L(`${IND}${IND}let mut ${s.param}: Val = __zoo_caught(__e);`));
      out.push(...this.body(s.handler, ind + IND + IND), L(`${IND}}`));
    } else {
      out.push(L(`${IND}Err(__e) => {`), ...(s.finalizer ? this.body(s.finalizer, ind + IND + IND) : []), L(`${IND}${IND}return Err(__e);`), L(`${IND}}`));
    }
    out.push(L('}'));
    if (s.finalizer) out.push(...this.body(s.finalizer, ind));
    return out;
  }

  // ---- functions

  fnBodyLines(fn, ind) {
    return [...this.body(fn.params, ind), ...this.body(fn.body, ind), `${ind}Ok(Val::Undef)`];
  }
  fnBody(fn, ind) {
    return this.fnBodyLines(fn, ind).join('\n');
  }
}

// ---------------------------------------------------------------- route & crate emission

/** Rust for one route IR (route fn(s), params const, helpers, consts). */
export function emitRoute(route, { printer = new RustPrinter() } = {}) {
  const P = printer;
  const out = [];
  const paramsConst = `const ${route.paramsConst}: &[(&str, bool)] = &[${route.params.map((p) => `(${rustStr(p.name)}, ${p.catchAll})`).join(', ')}];`;
  out.push(`// ---- route ${route.index}: ${route.name} (${route.file})`);
  out.push(paramsConst);
  const routeFn = (name, fn) => {
    out.push(`fn ${name}(cx: &mut Ctx) -> Result<(), Val> {`);
    out.push(...P.body(fn.params, IND));
    out.push(...P.body(fn.body, IND));
    out.push(`${IND}Ok(())`);
    out.push('}');
  };
  if (route.style === 'node') {
    routeFn(`route_${route.index}`, route.node);
  } else {
    const methods = Object.keys(route.methods);
    const allow = [...methods];
    if (!allow.includes('HEAD') && allow.includes('GET')) allow.push('HEAD');
    if (!allow.includes('OPTIONS')) allow.push('OPTIONS');
    const allowStr = rustStr(allow.join(', '));
    out.push(`fn route_${route.index}(cx: &mut Ctx) -> Result<(), Val> {`);
    out.push(`${IND}let __m = cx.req_method();`);
    out.push(`${IND}match __m.as_str() {`);
    for (const m of methods) out.push(`${IND}${IND}Some(${rustStr(m)}) => route_${route.index}_${m.toLowerCase()}(cx),`);
    if (!methods.includes('HEAD') && methods.includes('GET')) out.push(`${IND}${IND}Some("HEAD") => route_${route.index}_get(cx),`);
    if (!methods.includes('OPTIONS')) out.push(`${IND}${IND}Some("OPTIONS") => { cx.res_status(&Val::Num(204.0)); cx.res_header(&Val::str("allow"), &Val::str(${allowStr})); cx.res_end(&Val::Undef); Ok(()) }`);
    out.push(`${IND}${IND}_ => { cx.res_status(&Val::Num(405.0)); cx.res_header(&Val::str("allow"), &Val::str(${allowStr})); cx.res_end(&Val::Undef); Ok(()) }`);
    out.push(`${IND}}`);
    out.push('}');
    for (const m of methods) routeFn(`route_${route.index}_${m.toLowerCase()}`, route.methods[m]);
  }
  for (const h of route.helpers) {
    out.push(`fn ${h.name}(cx: &mut Ctx, __args: &[Val]) -> Result<Val, Val> {`);
    out.push(...P.fnBodyLines(h.fn, IND));
    out.push('}');
  }
  for (const c of route.consts) {
    out.push(`fn ${c.name}(cx: &mut Ctx) -> Result<Val, Val> {`);
    out.push(`${IND}Ok(${P.E(c.e)})`);
    out.push('}');
  }
  return out.join('\n');
}

export const PRELUDE = `
// ---- prelude: bridge helpers used by generated routes ----

/// Response value for app-router handlers: a tagged object that \`__zoo_send\` turns into the bridge response.
fn __zoo_resp(kind: &str, a: Val, b: Val) -> Val {
    let mut o = Val::obj();
    o.set_str("__zoo", Val::str(kind));
    o.set_str("a", a);
    o.set_str("b", b);
    o
}

fn __zoo_send(cx: &mut Ctx, v: &Val) -> Result<(), Val> {
    let kind = v.get_str("__zoo");
    match kind.as_str() {
        Some("json") => { let a = v.get_str("a"); let b = v.get_str("b"); cx.respond_json(&a, &b); Ok(()) }
        Some("raw") => { let a = v.get_str("a"); let b = v.get_str("b"); cx.respond(&a, &b); Ok(()) }
        Some("redirect") => {
            let url = v.get_str("a");
            let mut st = v.get_str("b");
            if let Val::Obj(_) = st { st = st.get_str("status"); }
            cx.respond_redirect(&url, &st);
            Ok(())
        }
        _ => {
            if v.is_undef() { Ok(()) } else { Err(Val::str("TypeError: the handler returned a value that is not a Response")) }
        }
    }
}

/// Runtime throws are strings ("SyntaxError: ..."); in a catch they become
/// Error-like objects so \`e.message\` / \`e.name\` read as in Node.
fn __zoo_caught(v: Val) -> Val {
    if let Val::Str(s) = &v {
        if let Some(i) = s.find(": ") {
            let name = &s[..i];
            if name.ends_with("Error") && !name.contains(' ') {
                let mut o = Val::obj();
                o.set_str("name", Val::str(name));
                o.set_str("message", Val::str(&s[i + 2..]));
                return o;
            }
        }
    }
    v
}

fn __zoo_param_value(s: &str, catch_all: bool) -> Val {
    if catch_all {
        Val::Arr(s.split('/').filter(|p| !p.is_empty()).map(|p| Val::Str(zv::url_decode(p))).collect())
    } else {
        Val::Str(zv::url_decode(s))
    }
}

/// A dynamic segment, passed by the gateway as the \`x-zoo-param-<name>\` header.
fn __zoo_param(cx: &mut Ctx, name: &str, catch_all: bool) -> Val {
    match cx.req_header(&Val::Str(format!("x-zoo-param-{}", name))) {
        Val::Str(s) => __zoo_param_value(&s, catch_all),
        _ => Val::Undef,
    }
}

fn __zoo_params(cx: &mut Ctx, params: &[(&str, bool)]) -> Val {
    let mut o = Val::obj();
    for (name, catch_all) in params.iter() {
        let v = __zoo_param(cx, name, *catch_all);
        if !v.is_undef() { o.set_str(name, v); }
    }
    o
}

/// \`req.query\`: the query string plus the route's dynamic segments (pages-router semantics).
fn __zoo_query(cx: &mut Ctx, params: &[(&str, bool)]) -> Val {
    let mut q = cx.req_query();
    for (name, catch_all) in params.iter() {
        let v = __zoo_param(cx, name, *catch_all);
        if !v.is_undef() { q.set_str(name, v); }
    }
    q
}

fn __zoo_cookies(cx: &mut Ctx, _a: &[Val]) -> Val {
    let mut o = Val::obj();
    if let Val::Str(h) = cx.req_header(&Val::str("cookie")) {
        for part in h.split(';') {
            let p = part.trim();
            if let Some(i) = p.find('=') { o.set_str(&p[..i], Val::Str(zv::url_decode(&p[i + 1..]))); }
        }
    }
    o
}

fn __zoo_cookie_get(cx: &mut Ctx, a: &[Val]) -> Val {
    let name = a.get(0).cloned().unwrap_or(Val::Undef);
    let v = __zoo_cookies(cx, &[]).get(&name);
    if v.is_undef() { return Val::Undef; }
    let mut o = Val::obj();
    o.set_str("name", name);
    o.set_str("value", v);
    o
}

fn __zoo_cookie_has(cx: &mut Ctx, a: &[Val]) -> Val {
    let name = a.get(0).cloned().unwrap_or(Val::Undef);
    Val::Bool(__zoo_cookies(cx, &[]).has(&name))
}

fn __zoo_cookie_all(cx: &mut Ctx, _a: &[Val]) -> Val {
    let mut out = Val::arr();
    if let Val::Obj(kv) = __zoo_cookies(cx, &[]) {
        for (k, v) in kv {
            let mut o = Val::obj();
            o.set_str("name", Val::Str(k));
            o.set_str("value", v);
            out.push(o);
        }
    }
    out
}

fn __zoo_header_has(cx: &mut Ctx, a: &[Val]) -> Val {
    let name = a.get(0).cloned().unwrap_or(Val::Undef);
    Val::Bool(!cx.req_header(&name).is_nullish())
}

fn __zoo_query_has(cx: &mut Ctx, a: &[Val]) -> Val {
    let name = a.get(0).cloned().unwrap_or(Val::Undef);
    Val::Bool(cx.req_query().has(&name))
}

fn __zoo_query_get_all(cx: &mut Ctx, a: &[Val]) -> Val {
    let name = a.get(0).cloned().unwrap_or(Val::Undef);
    match cx.req_query_get(&name) {
        Val::Null | Val::Undef => Val::arr(),
        v => Val::Arr(alloc::vec![v]),
    }
}

/// \`url.search\` (with '?') or \`searchParams.toString()\` (without).
fn __zoo_search(cx: &mut Ctx, a: &[Val]) -> Val {
    let with_q = a.get(0).map(|v| v.truthy()).unwrap_or(false);
    let u = cx.req_url().to_js_string();
    match u.find('?') {
        Some(i) => Val::Str(String::from(if with_q { &u[i..] } else { &u[i + 1..] })),
        None => Val::str(""),
    }
}

fn __zoo_assign(_cx: &mut Ctx, a: &[Val]) -> Val {
    let mut t = a.get(0).cloned().unwrap_or(Val::obj());
    for src in a.iter().skip(1) {
        if let Val::Obj(kv) = src { for (k, v) in kv.iter() { t.set_str(k, v.clone()); } }
    }
    t
}

/// Object rest: the object without the listed keys.
fn __zoo_omit(_cx: &mut Ctx, a: &[Val]) -> Val {
    let mut out = Val::obj();
    let skip: Vec<String> = a.get(1).map(|v| v.iter_values().iter().map(|k| k.to_js_string()).collect()).unwrap_or_default();
    if let Some(Val::Obj(kv)) = a.get(0) {
        for (k, v) in kv.iter() { if !skip.iter().any(|s| s == k) { out.set_str(k, v.clone()); } }
    }
    out
}

fn __zoo_from_entries(_cx: &mut Ctx, a: &[Val]) -> Val {
    let mut o = Val::obj();
    for pair in a.get(0).map(|v| v.iter_values()).unwrap_or_default() {
        let k = pair.get(&Val::Num(0.0));
        let v = pair.get(&Val::Num(1.0));
        o.set(&k, v);
    }
    o
}

fn __zoo_array_from(_cx: &mut Ctx, a: &[Val]) -> Val {
    Val::Arr(a.get(0).map(|v| v.iter_values()).unwrap_or_default())
}

/// Array rest / rest parameters: elements from index \`a[1]\` on.
fn __zoo_slice_from(_cx: &mut Ctx, a: &[Val]) -> Val {
    let items = a.get(0).map(|v| v.iter_values()).unwrap_or_default();
    let from = a.get(1).map(|v| v.to_num()).unwrap_or(0.0).max(0.0) as usize;
    Val::Arr(items.into_iter().skip(from).collect())
}

/// console.log: joined like Node prints it, into the program log.
fn __zoo_log(_cx: &mut Ctx, a: &[Val]) -> Val {
    let mut s = String::new();
    for (i, v) in a.iter().enumerate() {
        if i > 0 { s.push(' '); }
        match v {
            Val::Str(x) => s.push_str(x),
            Val::Obj(_) | Val::Arr(_) => s.push_str(&zjson::stringify(v)),
            other => s.push_str(&other.to_js_string()),
        }
    }
    zoo_host::wire::log_str(&s);
    Val::Undef
}

/// \`new URL(input, base)\` as a string (enough for redirect targets).
fn __zoo_url(_cx: &mut Ctx, a: &[Val]) -> Val {
    let input = a.get(0).map(|v| v.to_js_string()).unwrap_or_default();
    let base = a.get(1).map(|v| if v.is_undef() { String::new() } else { v.to_js_string() }).unwrap_or_default();
    if input.contains("://") || base.is_empty() { return Val::Str(input); }
    let origin_end = match base.find("://") {
        Some(i) => base[i + 3..].find('/').map(|j| i + 3 + j).unwrap_or(base.len()),
        None => 0,
    };
    if input.starts_with('/') { return Val::Str(format!("{}{}", &base[..origin_end], input)); }
    let path_end = base.rfind('/').map(|i| i + 1).unwrap_or(base.len()).max(origin_end).min(base.len());
    Val::Str(format!("{}{}", &base[..path_end], input))
}

/// Number.isInteger / isNaN / isFinite / isSafeInteger
fn __zoo_num(_cx: &mut Ctx, a: &[Val]) -> Val {
    let name = a.get(0).map(|v| v.to_js_string()).unwrap_or_default();
    let n = match a.get(1) { Some(Val::Num(n)) => *n, _ => return Val::Bool(false) };
    Val::Bool(match name.as_str() {
        "isInteger" => n.is_finite() && n == libm::trunc(n),
        "isNaN" => n.is_nan(),
        "isFinite" => n.is_finite(),
        "isSafeInteger" => n.is_finite() && n == libm::trunc(n) && libm::fabs(n) <= 9007199254740991.0,
        _ => false,
    })
}

/// res.writeHead(status, headers)
fn __zoo_set_headers(cx: &mut Ctx, a: &[Val]) -> Val {
    if let Some(Val::Obj(kv)) = a.get(0) {
        for (k, v) in kv.iter() { cx.res_header(&Val::str(k), v); }
    }
    Val::Undef
}
`;

/**
 * Whole crate: { 'Cargo.toml', 'src/lib.rs' }.
 * @param {{ name: string, runtimePath: string, env: [string,string][], routes: string[] (emitted route sources), routeCount: number, header?: string }} o
 */
export function emitCrate({ name, runtimePath, env, routes, routeCount, header = '' }) {
  const crate = sanitizeCrateName(name);
  const cargo = `[package]
name = ${JSON.stringify(crate)}
version = "0.1.0"
edition = "2021"
description = "Generated by openzoo-transmute: Vercel Lambdas re-hosted as a Solana program"
publish = false

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
pinocchio = "0.11.2"
libm = "0.2"
zoo-host = { path = ${JSON.stringify(runtimePath)} }

[profile.release]
# Size is rent: every KB of program is ~0.007 SOL on mainnet.
opt-level = "z"
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
debug = false
overflow-checks = false
`;
  const envTable = env.map(([k, v]) => `(${rustStr(k)}, ${rustStr(v)})`).join(', ');
  const routesTable = Array.from({ length: routeCount }, (_, i) => `route_${i}`).join(', ');
  const lib = `//! Generated by openzoo-transmute — do not edit.
${header ? header.split('\n').map((l) => `//! ${l}`.trimEnd()).join('\n') + '\n' : ''}#![no_std]
#![allow(unused_mut, unused_variables, unused_assignments, dead_code, unused_parens, unreachable_code, unused_braces, unused_labels, unused_imports, non_snake_case, non_upper_case_globals, unused_unsafe, clippy::all)]
extern crate alloc;
use alloc::{format, string::String, vec::Vec};
use pinocchio::{AccountView, Address, ProgramResult};
use zoo_host::{Ctx, Route, Val};
use zoo_host::val as zv;
use zoo_host::json as zjson;

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

/// The Lambda environment table, baked at build time (public on chain).
const ENV: &[(&str, &str)] = &[${envTable}];
/// Route table: instruction byte 1 indexes it.
const ROUTES: &[Route] = &[${routesTable}];

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    zoo_host::dispatch(program_id, accounts, data, ROUTES, ENV)
}
${PRELUDE}
${routes.join('\n\n')}
`;
  return { 'Cargo.toml': cargo, 'src/lib.rs': lib, crateName: crate };
}
