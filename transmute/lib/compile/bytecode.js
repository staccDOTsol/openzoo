// IR → bytecode for the shared runtime (runtime/zoo-host/src/vm.rs).
//
// Same IR the Rust printer consumes, same semantics: every expression leaves
// one `Val` on the stack; statements leave nothing. Callbacks, local closures,
// IIFEs and try bodies are inline regions of their parent function sharing its
// local slots and getting their own `args` — which is exactly how the Rust
// backend's closures see the enclosing bindings.
import { helperIds, hostIds } from './hostids.js';

export const MAGIC = Buffer.from('ZOOB');
export const VERSION = 1;

export const OP = {
  NOP: 0, PUSH_CONST: 1, PUSH_UNDEF: 2, PUSH_NULL: 3, DUP: 4, POP: 5, SWAP: 6, LOAD: 7, STORE: 8, LOAD_ARG: 9, ARGS_FROM: 10,
  NEW_OBJ: 11, OBJ_SET_K: 12, OBJ_SET: 13, OBJ_SPREAD: 14, NEW_ARR: 15, ARR_PUSH: 16, ARR_SPREAD: 17, GET_K: 18, GET: 19,
  TEMPLATE: 20, BIN: 21, CMP: 22, UNARY: 23, IN: 24, JMP: 25, JF: 26, JT: 27, JF_KEEP: 28, JT_KEEP: 29, JNN_KEEP: 30,
  JNULLISH_UNDEF: 31, CALLM: 32, HOST: 33, HELPER: 34, MATH: 35, GLOBAL: 36, JSON_PARSE: 37, JSON_STRINGIFY: 38, KEYS: 39,
  VALUES: 40, ENTRIES: 41, ISARRAY: 42, NEW_ERROR: 43, LOG: 44, RESP: 45, PARAMS: 46, PARAM: 47, CALL_FN: 48, CALL_INLINE: 49,
  RET: 50, SEND: 51, THROW: 52, TRY_PUSH: 53, TRY_POP: 54, CAUGHT: 55, ITER_INIT: 56, ITER_NEXT: 57, STORE_PATH: 58,
  STORE_PATH_DISCARD: 59, DELETE_PATH: 60, TRUTHY: 61, NULLISH: 62, STRICT_EQ_KEEP: 63,
};
const BIN = { add: 0, sub: 1, mul: 2, div: 3, rem: 4, pow: 5, bit_and: 6, bit_or: 7, bit_xor: 8, shl: 9, shr: 10, ushr: 11 };
const CMP = { strict_eq: 0, strict_ne: 1, loose_eq: 2, loose_ne: 3, lt: 4, le: 5, gt: 6, ge: 7 };
const UNARY = { neg: 0, plus: 1, not: 2, bitnot: 3, typeof: 4, void: 5 };
const CALLM_CB = 1, CALLM_DEFAULT_SORT = 2, CALLM_MUT = 4;
const HOST_Q = 1, HOST_VOID = 2;
const METHOD_INDEX = { GET: 0, POST: 1, PUT: 2, DELETE: 3, PATCH: 4, OPTIONS: 5, HEAD: 6 };

export class BytecodeError extends Error {}

/** Module-wide constant pool. */
class Consts {
  constructor() { this.list = []; this.index = new Map(); }
  key(v) { return typeof v === 'number' ? (Number.isNaN(v) ? 'n:NaN' : `n:${Object.is(v, -0) ? '-0' : v}`) : `${typeof v}:${v}`; }
  add(v) {
    const k = this.key(v);
    if (this.index.has(k)) return this.index.get(k);
    const i = this.list.length;
    if (i >= 65535) throw new BytecodeError('too many constants');
    this.list.push(v); this.index.set(k, i);
    return i;
  }
  encode() {
    const parts = [u16(this.list.length)];
    for (const v of this.list) {
      if (v === undefined) parts.push(Buffer.from([0]));
      else if (v === null) parts.push(Buffer.from([1]));
      else if (v === false) parts.push(Buffer.from([2]));
      else if (v === true) parts.push(Buffer.from([3]));
      else if (typeof v === 'number') { const b = Buffer.alloc(9); b[0] = 4; b.writeDoubleLE(v, 1); parts.push(b); }
      else { const s = Buffer.from(String(v), 'utf8'); parts.push(Buffer.from([5]), u32(s.length), s); }
    }
    return Buffer.concat(parts);
  }
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

/** One top-level function's code: slot table, jumps, labels. */
class Fn {
  constructor(consts, mod) {
    this.consts = consts; this.mod = mod;
    this.code = [];           // bytes
    this.slots = new Map();   // name -> slot
    this.nlocals = 0;
    this.labels = [];         // loop/switch/chain label contexts
    this.tries = [];          // active try contexts: { finalizer, phase, tryDepthAtLoop? }
    this.inlines = new Map(); // letfn name -> code offset
    this.tmp = 0;
  }
  slot(name) {
    if (!this.slots.has(name)) { this.slots.set(name, this.nlocals++); if (this.nlocals > 65535) throw new BytecodeError('too many locals'); }
    return this.slots.get(name);
  }
  temp() { return this.slot(`__t${this.tmp++}`); }
  emit(...bytes) { for (const b of bytes) this.code.push(b & 0xff); }
  u16(n) { this.emit(n & 0xff, (n >> 8) & 0xff); }
  u32(n) { this.emit(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); }
  i32(n) { this.u32(n >>> 0); }
  pos() { return this.code.length; }
  /** Emit a jump with a patchable 4-byte offset; returns the patch site. */
  jmp(op) { this.emit(op); const at = this.pos(); this.i32(0); return at; }
  /** Point the jump at `at` to the current position (offset relative to the end of the operand). */
  patch(at, target = this.pos()) { const rel = target - (at + 4); this.code[at] = rel & 0xff; this.code[at + 1] = (rel >> 8) & 0xff; this.code[at + 2] = (rel >> 16) & 0xff; this.code[at + 3] = (rel >>> 24) & 0xff; }
  jumpTo(op, target) { this.emit(op); const at = this.pos(); this.i32(0); this.patch(at, target); }
  k(v) { return this.consts.add(v); }
  pushConst(v) { this.emit(OP.PUSH_CONST); this.u16(this.k(v)); }

  // ---- expressions

  E(ir) {
    switch (ir.k) {
      case 'undef': this.emit(OP.PUSH_UNDEF); return;
      case 'null': this.emit(OP.PUSH_NULL); return;
      case 'bool': this.pushConst(!!ir.v); return;
      case 'num': this.pushConst(ir.v); return;
      case 'str': this.pushConst(String(ir.v)); return;
      case 'raw': return this.raw(ir.code);
      case 'var': this.emit(OP.LOAD); this.u16(this.slot(ir.name)); return;
      case 'template': {
        for (const p of ir.parts) { if (p.s !== undefined) this.pushConst(p.s); else this.E(p.e); }
        this.emit(OP.TEMPLATE, Math.min(255, ir.parts.length));
        if (ir.parts.length > 255) throw new BytecodeError('template too long');
        return;
      }
      case 'obj': {
        this.emit(OP.NEW_OBJ);
        for (const p of ir.props) {
          if (p.spread) { this.E(p.spread); this.emit(OP.OBJ_SPREAD); continue; }
          if (typeof p.key === 'string') { this.E(p.value); this.emit(OP.OBJ_SET_K); this.u16(this.k(p.key)); }
          else { this.E(p.key.e); this.E(p.value); this.emit(OP.OBJ_SET); }
        }
        return;
      }
      case 'arr': {
        this.emit(OP.NEW_ARR);
        for (const i of ir.items) {
          if (i.spread) { this.E(i.spread); this.emit(OP.ARR_SPREAD); }
          else { if (i.hole) this.emit(OP.PUSH_UNDEF); else this.E(i.e); this.emit(OP.ARR_PUSH); }
        }
        return;
      }
      case 'get': this.E(ir.obj); this.emit(OP.GET_K); this.u16(this.k(ir.key)); return;
      case 'getc': this.E(ir.obj); this.E(ir.key); this.emit(OP.GET); return;
      case 'chain': {
        const ctx = { kind: 'chain', name: ir.label, breaks: [] };
        this.labels.push(ctx);
        this.E(ir.e);
        this.labels.pop();
        for (const at of ctx.breaks) this.patch(at);
        return;
      }
      case 'optcheck': {
        this.E(ir.e);
        const ctx = [...this.labels].reverse().find((l) => l.kind === 'chain' && l.name === ir.label);
        if (!ctx) throw new BytecodeError(`optcheck outside its chain ${ir.label}`);
        ctx.breaks.push(this.jmp(OP.JNULLISH_UNDEF));
        return;
      }
      case 'bin': this.E(ir.l); this.E(ir.r); this.emit(OP.BIN, BIN[ir.op] ?? this.bad(`binary ${ir.op}`)); return;
      case 'cmp': this.E(ir.l); this.E(ir.r); this.emit(OP.CMP, CMP[ir.op] ?? this.bad(`compare ${ir.op}`)); return;
      case 'logical': {
        this.E(ir.l);
        const at = this.jmp(ir.op === 'and' ? OP.JF_KEEP : ir.op === 'or' ? OP.JT_KEEP : OP.JNN_KEEP);
        this.E(ir.r);
        this.patch(at);
        return;
      }
      case 'cond': {
        this.C(ir.test);
        const toElse = this.jmp(OP.JF);
        this.E(ir.then);
        const toEnd = this.jmp(OP.JMP);
        this.patch(toElse);
        this.E(ir.else);
        this.patch(toEnd);
        return;
      }
      case 'unary': this.E(ir.e); this.emit(OP.UNARY, UNARY[ir.op] ?? this.bad(`unary ${ir.op}`)); return;
      case 'in': this.E(ir.key); this.E(ir.obj); this.emit(OP.IN); return;
      case 'delete': {
        if (ir.lv.k !== 'lv-member') { this.pushConst(true); return; }
        const path = this.lvPath(ir.lv);
        if (!path) { this.E(ir.lv.obj.e ?? { k: 'undef' }); this.emit(OP.POP); this.pushConst(true); return; }
        const keys = this.hoistKeys(path.keys);
        this.pushKeys(keys);
        this.emit(OP.DELETE_PATH); this.u16(this.slot(path.root)); this.emit(keys.length);
        return;
      }
      case 'assign': return this.assign(ir);
      case 'update': return this.update(ir);
      case 'seq': ir.exprs.forEach((e, i) => { this.E(e); if (i < ir.exprs.length - 1) this.emit(OP.POP); }); return;
      case 'callm': return this.callm(ir);
      case 'host': {
        const id = hostIds[ir.fn];
        if (id === undefined) this.bad(`host ${ir.fn}`);
        for (const a of ir.args) this.E(a);
        this.emit(OP.HOST, id, ir.args.length, (ir.q ? HOST_Q : 0) | (ir.void ? HOST_VOID : 0));
        return;
      }
      case 'pre': for (const s of ir.stmts) this.S(s); this.E(ir.e); return;
      case 'math': for (const a of ir.args) this.E(a); this.emit(OP.MATH); this.u16(this.k(ir.name)); this.emit(ir.args.length); return;
      case 'global': for (const a of ir.args) this.E(a); this.emit(OP.GLOBAL); this.u16(this.k(ir.name)); this.emit(ir.args.length); return;
      case 'jsonparse': this.E(ir.e); this.emit(OP.JSON_PARSE); return;
      case 'jsonstringify': this.E(ir.e); this.emit(OP.JSON_STRINGIFY); return;
      case 'keys': this.E(ir.e); this.emit(OP.KEYS); return;
      case 'values': this.E(ir.e); this.emit(OP.VALUES); return;
      case 'entries': this.E(ir.e); this.emit(OP.ENTRIES); return;
      case 'isarray': this.E(ir.e); this.emit(OP.ISARRAY); return;
      case 'newerror': for (const a of ir.args) this.E(a); this.emit(OP.NEW_ERROR); this.u16(this.k(ir.name)); this.emit(ir.args.length); return;
      case 'log': for (const a of ir.args) this.E(a); this.emit(OP.LOG, ir.args.length); return;
      case 'helper': {
        const id = helperIds[ir.name];
        if (id === undefined) this.bad(`helper ${ir.name}`);
        for (const a of ir.args) this.E(a);
        this.emit(OP.HELPER, id, ir.args.length);
        return;
      }
      case 'resp': this.E(ir.body); this.E(ir.init); this.emit(OP.RESP); this.u16(this.k(ir.kind)); return;
      case 'params':
        if (ir.fn === 'query') { this.emit(OP.PARAMS, 0); return; }
        if (ir.fn === 'params') { this.emit(OP.PARAMS, 1); return; }
        this.emit(OP.PARAM); this.u16(this.k(ir.name)); this.emit(ir.catchAll ? 1 : 0); return;
      case 'callh': {
        for (const a of ir.args) this.E(a);
        if (this.inlines.has(ir.name)) { this.emit(OP.CALL_INLINE); this.u32(this.inlines.get(ir.name)); this.emit(ir.args.length); return; }
        const fi = this.mod.fnIndex.get(ir.name);
        if (fi === undefined) this.bad(`call of unknown function ${ir.name}`);
        this.emit(OP.CALL_FN); this.u16(fi); this.emit(ir.args.length);
        return;
      }
      case 'constref': {
        const fi = this.mod.fnIndex.get(ir.name);
        if (fi === undefined) this.bad(`unknown const ${ir.name}`);
        this.emit(OP.CALL_FN); this.u16(fi); this.emit(0);
        return;
      }
      case 'iife': {
        for (const a of ir.args) this.E(a);
        const off = this.region(ir.fn);
        this.emit(OP.CALL_INLINE); this.u32(off); this.emit(ir.args.length);
        return;
      }
      default: this.bad(`IR expression ${ir.k}`);
    }
  }

  bad(what) { throw new BytecodeError(`bytecode: unsupported ${what}`); }

  /** The handful of literal Rust snippets the lowering emits. */
  raw(code) {
    let m;
    if ((m = code.match(/^__args\.get\((\d+)\)\.cloned\(\)\.unwrap_or\(Val::Undef\)$/))) { this.emit(OP.LOAD_ARG, Number(m[1])); return; }
    if (code === 'Val::Arr(__args.to_vec())') { this.emit(OP.ARGS_FROM, 0); return; }
    if (code === 'Val::Num(f64::NAN)') { this.pushConst(NaN); return; }
    if (code === 'Val::Num(f64::INFINITY)') { this.pushConst(Infinity); return; }
    if (code === 'Val::Num(f64::NEG_INFINITY)') { this.pushConst(-Infinity); return; }
    this.bad(`raw Rust "${code}"`);
  }

  /** Emit an inline region (callback / closure / iife body) out of line; returns its offset. */
  region(fn) {
    const over = this.jmp(OP.JMP);
    const off = this.pos();
    const savedTries = this.tries; this.tries = [];
    const savedLabels = this.labels; this.labels = [];
    for (const s of fn.params) this.S(s);
    for (const s of fn.body) this.S(s);
    this.emit(OP.PUSH_UNDEF, OP.RET);
    this.tries = savedTries; this.labels = savedLabels;
    this.patch(over);
    return off;
  }

  // ---- conditions

  C(c) {
    switch (c.k) {
      case 'c-truthy': this.E(c.e); return;
      case 'c-not': this.C(c.c); this.emit(OP.UNARY, UNARY.not); return;
      case 'c-and': { this.C(c.l); const at = this.jmp(OP.JF_KEEP); this.C(c.r); this.patch(at); return; }
      case 'c-or': { this.C(c.l); const at = this.jmp(OP.JT_KEEP); this.C(c.r); this.patch(at); return; }
      case 'c-cmp': this.E(c.l); this.E(c.r); this.emit(OP.CMP, CMP[c.op] ?? this.bad(`compare ${c.op}`)); return;
      case 'c-nullish': this.E(c.e); this.emit(OP.NULLISH); return;
      case 'c-undef': this.E(c.e); this.emit(OP.PUSH_UNDEF); this.emit(OP.CMP, CMP.strict_eq); return;
      default: this.bad(`condition ${c.k}`);
    }
  }

  // ---- lvalues

  /** Flatten an lvalue into { root: localName, keys: [...] } or null when the base is an expression. */
  lvPath(lv) {
    const keys = [];
    let cur = lv;
    while (cur.k === 'lv-member') { keys.unshift(cur.key); cur = cur.obj; }
    if (cur.k === 'lv-var') return { root: cur.name, keys };
    return null; // lv-expr base
  }
  /** Evaluate computed keys once, left to right, into temps. Returns descriptors. */
  hoistKeys(keys) {
    return keys.map((key) => {
      if (typeof key === 'string') return { s: key };
      const t = this.temp();
      this.E(key); this.emit(OP.STORE); this.u16(t);
      return { t };
    });
  }
  pushKeys(keys) { for (const k of keys) { if (k.s !== undefined) this.pushConst(k.s); else { this.emit(OP.LOAD); this.u16(k.t); } } }
  readPath(root, keys) {
    this.emit(OP.LOAD); this.u16(this.slot(root));
    for (const k of keys) { if (k.s !== undefined) { this.emit(OP.GET_K); this.u16(this.k(k.s)); } else { this.emit(OP.LOAD); this.u16(k.t); this.emit(OP.GET); } }
  }
  /** Read an lvalue whose base is an expression (lv-expr chain). */
  readLvExpr(lv) {
    if (lv.k === 'lv-var') { this.emit(OP.LOAD); this.u16(this.slot(lv.name)); return; }
    if (lv.k === 'lv-expr') { this.E(lv.e); return; }
    this.readLvExpr(lv.obj);
    if (typeof lv.key === 'string') { this.emit(OP.GET_K); this.u16(this.k(lv.key)); } else { this.E(lv.key); this.emit(OP.GET); }
  }

  assign(ir) {
    const v = this.temp();
    const path = this.lvPath(ir.lv);
    if (ir.lv.k === 'lv-var') {
      if (ir.op) { this.emit(OP.LOAD); this.u16(this.slot(ir.lv.name)); this.E(ir.value); this.emit(OP.BIN, BIN[ir.op]); }
      else this.E(ir.value);
      this.emit(OP.DUP); this.emit(OP.STORE); this.u16(this.slot(ir.lv.name));
      return;
    }
    if (path) {
      const keys = this.hoistKeys(path.keys);
      if (ir.op) { this.readPath(path.root, keys); this.E(ir.value); this.emit(OP.BIN, BIN[ir.op]); } else this.E(ir.value);
      this.emit(OP.STORE); this.u16(v);
      this.emit(OP.LOAD); this.u16(v);
      this.pushKeys(keys);
      this.emit(OP.STORE_PATH); this.u16(this.slot(path.root)); this.emit(keys.length);
      this.emit(OP.LOAD); this.u16(v);
      return;
    }
    // expression base: evaluate for effects, the write is lost (as in the Rust backend)
    if (ir.lv.k === 'lv-expr') { this.E(ir.value); return; }
    if (ir.op) { this.readLvExpr(ir.lv); this.E(ir.value); this.emit(OP.BIN, BIN[ir.op]); } else this.E(ir.value);
    return;
  }

  update(ir) {
    const path = this.lvPath(ir.lv);
    const old = this.temp(), nw = this.temp();
    const keys = path ? this.hoistKeys(path.keys) : [];
    if (path) this.readPath(path.root, keys); else this.readLvExpr(ir.lv);
    this.emit(OP.UNARY, UNARY.plus); this.emit(OP.STORE); this.u16(old);
    this.emit(OP.LOAD); this.u16(old); this.pushConst(1); this.emit(OP.BIN, ir.delta > 0 ? BIN.add : BIN.sub); this.emit(OP.STORE); this.u16(nw);
    if (path) { this.emit(OP.LOAD); this.u16(nw); this.pushKeys(keys); this.emit(OP.STORE_PATH); this.u16(this.slot(path.root)); this.emit(keys.length); }
    this.emit(OP.LOAD); this.u16(ir.prefix ? nw : old);
  }

  callm(ir) {
    const path = ir.lv ? this.lvPath(ir.lv) : null;
    let keys = [];
    if (path) { keys = this.hoistKeys(path.keys); this.readPath(path.root, keys); }
    else if (ir.lv) this.readLvExpr(ir.lv);
    else this.E(ir.recv);
    for (const a of ir.args) this.E(a);
    let flags = 0;
    let cbOff = null;
    if (ir.cb) {
      if (ir.cb.kind === 'fn') { flags |= CALLM_CB; cbOff = this.region(ir.cb.fn); }
      else if (ir.cb.kind === 'ref') {
        flags |= CALLM_CB;
        if (this.inlines.has(ir.cb.name)) cbOff = this.inlines.get(ir.cb.name);
        else {
          const fi = this.mod.fnIndex.get(ir.cb.name);
          if (fi === undefined) this.bad(`callback ${ir.cb.name}`);
          // wrap the module function in a tiny inline trampoline: args -> CALL_FN
          const over = this.jmp(OP.JMP);
          cbOff = this.pos();
          this.emit(OP.ARGS_FROM, 0);
          this.emit(OP.CALL_FN_SPREAD ?? OP.NOP); // placeholder, replaced below
          this.code.length -= 2;
          // simple: pass up to 3 positional args
          this.code.length -= 0;
          this.emit(OP.LOAD_ARG, 0, OP.LOAD_ARG, 1, OP.LOAD_ARG, 2, OP.CALL_FN); this.u16(fi); this.emit(3, OP.RET);
          this.patch(over);
        }
      } else flags |= CALLM_DEFAULT_SORT;
    }
    if (path) flags |= CALLM_MUT;
    this.emit(OP.CALLM); this.u16(this.k(ir.name)); this.emit(ir.args.length, flags);
    if (flags & CALLM_CB) this.u32(cbOff);
    if (path) { this.pushKeys(keys); this.emit(OP.STORE_PATH); this.u16(this.slot(path.root)); this.emit(keys.length); }
  }

  // ---- statements

  S(s) {
    switch (s.k) {
      case 'let': if (s.init) this.E(s.init); else this.emit(OP.PUSH_UNDEF); this.emit(OP.STORE); this.u16(this.slot(s.name)); return;
      case 'hoistvar': this.emit(OP.PUSH_UNDEF); this.emit(OP.STORE); this.u16(this.slot(s.name)); return;
      case 'expr': this.E(s.e); this.emit(OP.POP); return;
      case 'block': for (const x of s.body) this.S(x); return;
      case 'if': {
        this.C(s.test);
        const toElse = this.jmp(OP.JF);
        for (const x of s.then) this.S(x);
        if (s.else) { const toEnd = this.jmp(OP.JMP); this.patch(toElse); for (const x of s.else) this.S(x); this.patch(toEnd); }
        else this.patch(toElse);
        return;
      }
      case 'while': {
        const ctx = this.loop(s.label);
        const top = this.pos(); ctx.continueTarget = top;
        this.C(s.test); const exit = this.jmp(OP.JF);
        for (const x of s.body) this.S(x);
        this.jumpTo(OP.JMP, top);
        this.patch(exit); this.endLoop(ctx);
        return;
      }
      case 'dowhile': {
        const ctx = this.loop(s.label);
        const top = this.pos();
        for (const x of s.body) this.S(x);
        ctx.continueTarget = this.pos(); this.patchContinues(ctx);
        this.C(s.test); this.jumpTo(OP.JT, top);
        this.endLoop(ctx);
        return;
      }
      case 'for': {
        for (const x of s.init) this.S(x);
        const ctx = this.loop(s.label);
        const top = this.pos();
        let exit = null;
        if (s.test) { this.C(s.test); exit = this.jmp(OP.JF); }
        for (const x of s.body) this.S(x);
        ctx.continueTarget = this.pos(); this.patchContinues(ctx);
        for (const x of s.update) this.S(x);
        this.jumpTo(OP.JMP, top);
        if (exit !== null) this.patch(exit);
        this.endLoop(ctx);
        return;
      }
      case 'forof':
      case 'forin': {
        const arr = this.temp(), idx = this.temp();
        this.E(s.iter);
        if (s.k === 'forin') this.emit(OP.KEYS);
        this.emit(OP.ITER_INIT); this.u16(arr); this.u16(idx);
        const ctx = this.loop(s.label);
        const top = this.pos(); ctx.continueTarget = top;
        this.emit(OP.ITER_NEXT); this.u16(arr); this.u16(idx); this.u16(this.slot(s.tmp)); const exit = this.pos(); this.i32(0);
        for (const x of s.body) this.S(x);
        this.jumpTo(OP.JMP, top);
        this.patch(exit); this.endLoop(ctx);
        return;
      }
      case 'break': { const ctx = this.findLabel(s.label); this.unwindTo(ctx.tryDepth); ctx.breaks.push(this.jmp(OP.JMP)); return; }
      case 'continue': {
        const ctx = this.findLabel(s.label); this.unwindTo(ctx.tryDepth);
        if (ctx.continueTarget != null) this.jumpTo(OP.JMP, ctx.continueTarget); else ctx.continues.push(this.jmp(OP.JMP));
        return;
      }
      case 'return': return this.ret(s);
      case 'throw': {
        this.E(s.e);
        // a throw from a catch handler still runs that try's finalizer
        for (let i = this.tries.length - 1; i >= 0; i--) { const t = this.tries[i]; if (t.phase === 'handler' && t.finalizer) this.finalizerCopy(t); }
        this.emit(OP.THROW);
        return;
      }
      case 'try': return this.tryStmt(s);
      case 'switch': {
        const d = this.temp();
        this.E(s.disc); this.emit(OP.STORE); this.u16(d);
        const ctx = this.loop(s.label); ctx.continueTarget = null; ctx.isSwitch = true;
        const jumps = [];
        let defaultIdx = -1;
        s.cases.forEach((c, i) => {
          if (c.test === null) { defaultIdx = i; return; }
          this.emit(OP.LOAD); this.u16(d); this.E(c.test); this.emit(OP.CMP, CMP.strict_eq);
          jumps.push([i, this.jmp(OP.JT)]);
        });
        const toDefault = this.jmp(OP.JMP);
        const bodyStarts = [];
        s.cases.forEach((c, i) => { bodyStarts[i] = this.pos(); for (const x of c.body) this.S(x); });
        for (const [i, at] of jumps) this.patch(at, bodyStarts[i]);
        this.patch(toDefault, defaultIdx >= 0 ? bodyStarts[defaultIdx] : this.pos());
        this.endLoop(ctx);
        return;
      }
      case 'letfn': {
        // captures are shared slots (the region reads the live locals)
        const off = this.region(s.fn);
        this.inlines.set(s.name, off);
        return;
      }
      default: this.bad(`IR statement ${s.k}`);
    }
  }

  loop(label) { const ctx = { kind: 'loop', name: label, breaks: [], continues: [], continueTarget: null, tryDepth: this.tries.length }; this.labels.push(ctx); return ctx; }
  patchContinues(ctx) { for (const at of ctx.continues) this.patch(at, ctx.continueTarget); ctx.continues = []; }
  endLoop(ctx) { this.labels.pop(); for (const at of ctx.breaks) this.patch(at); if (ctx.continues.length) { if (ctx.continueTarget == null) this.bad('continue in switch'); this.patchContinues(ctx); } }
  findLabel(name) {
    for (let i = this.labels.length - 1; i >= 0; i--) { const l = this.labels[i]; if (l.kind === 'loop' && (!name || l.name === name)) return l; }
    throw new BytecodeError(`bytecode: no loop for ${name || 'break/continue'}`);
  }
  /** Leaving `try` blocks on the way out of a loop/function: pop handlers, run finalizers. */
  unwindTo(depth) {
    for (let i = this.tries.length - 1; i >= depth; i--) {
      const t = this.tries[i];
      if (t.phase === 'body') this.emit(OP.TRY_POP);
      if (t.phase !== 'final' && t.finalizer) this.finalizerCopy(t);
    }
  }
  finalizerCopy(t) {
    const saved = t.phase; t.phase = 'final';
    for (const x of t.finalizer) this.S(x);
    t.phase = saved;
  }

  ret(s) {
    // value first (may itself throw inside the try), then unwind, then return
    if (s.mode === 'node') { if (s.value) { this.E(s.value); this.emit(OP.POP); } this.unwindTo(0); this.emit(OP.PUSH_UNDEF, OP.RET); return; }
    if (s.mode === 'web') {
      if (!s.value) { this.unwindTo(0); this.emit(OP.PUSH_UNDEF, OP.RET); return; }
      const t = this.temp();
      this.E(s.value); this.emit(OP.STORE); this.u16(t);
      this.unwindTo(0);
      this.emit(OP.LOAD); this.u16(t); this.emit(OP.SEND, OP.PUSH_UNDEF, OP.RET);
      return;
    }
    const t = this.temp();
    if (s.value) this.E(s.value); else this.emit(OP.PUSH_UNDEF);
    this.emit(OP.STORE); this.u16(t);
    this.unwindTo(0);
    this.emit(OP.LOAD); this.u16(t); this.emit(OP.RET);
  }

  tryStmt(s) {
    const t = { finalizer: s.finalizer || null, phase: 'body' };
    this.tries.push(t);
    const toHandler = this.jmp(OP.TRY_PUSH);
    for (const x of s.body) this.S(x);
    this.emit(OP.TRY_POP);
    t.phase = 'final';
    if (s.finalizer) this.finalizerCopy(t);
    const toEnd = this.jmp(OP.JMP);
    this.patch(toHandler);
    // exception value is on the stack
    if (s.handler) {
      t.phase = 'handler';
      if (s.param) { this.emit(OP.CAUGHT); this.emit(OP.STORE); this.u16(this.slot(s.param)); } else this.emit(OP.POP);
      for (const x of s.handler) this.S(x);
      t.phase = 'final';
      if (s.finalizer) this.finalizerCopy(t);
    } else {
      const e = this.temp();
      this.emit(OP.STORE); this.u16(e);
      t.phase = 'final';
      if (s.finalizer) this.finalizerCopy(t);
      this.emit(OP.LOAD); this.u16(e); this.emit(OP.THROW);
    }
    this.patch(toEnd);
    this.tries.pop();
  }

  finish() { return { nlocals: this.nlocals, code: Buffer.from(this.code) }; }
}

/**
 * Emit a module from lowered routes.
 * @param {{ routes: Array<{ir: object}>, env: [string,string][] }} o  routes as produced by lowerRoute (the `ir` field)
 * @returns {Buffer}
 */
export function emitModule({ routes, env = [] }) {
  const consts = new Consts();
  const mod = { fnIndex: new Map(), fns: [] };
  const routeDefs = [];
  // Pass 1: assign function indexes (helpers + consts + route fns) so calls can be forward.
  const plan = [];
  for (const r of routes) {
    const ir = r.ir;
    for (const h of ir.helpers) { mod.fnIndex.set(h.name, mod.fns.length); mod.fns.push(null); plan.push({ kind: 'helper', fn: h.fn }); }
    for (const c of ir.consts) { mod.fnIndex.set(c.name, mod.fns.length); mod.fns.push(null); plan.push({ kind: 'const', e: c.e }); }
    const def = { style: ir.style === 'node' ? 0 : 1, params: (ir.params || []).map((p) => [consts.add(p.name), p.catchAll ? 1 : 0]), nodeFn: 0, methods: [] };
    if (ir.style === 'node') { def.nodeFn = mod.fns.length; mod.fns.push(null); plan.push({ kind: 'route', fn: ir.node }); }
    else for (const m of Object.keys(ir.methods)) { if (!(m in METHOD_INDEX)) continue; def.methods.push([METHOD_INDEX[m], mod.fns.length]); mod.fns.push(null); plan.push({ kind: 'route', fn: ir.methods[m] }); }
    routeDefs.push(def);
  }
  // Pass 2: emit.
  plan.forEach((p, i) => {
    const f = new Fn(consts, mod);
    if (p.kind === 'const') { f.E(p.e); f.emit(OP.RET); }
    else { for (const s of p.fn.params) f.S(s); for (const s of p.fn.body) f.S(s); f.emit(OP.PUSH_UNDEF, OP.RET); }
    mod.fns[i] = f.finish();
  });
  const envPairs = env.map(([k, v]) => [consts.add(String(k)), consts.add(String(v))]);
  const parts = [MAGIC, Buffer.from([VERSION]), consts.encode()];
  parts.push(u16(envPairs.length));
  for (const [k, v] of envPairs) parts.push(u16(k), u16(v));
  parts.push(u16(mod.fns.length));
  for (const fn of mod.fns) parts.push(u16(fn.nlocals), u32(fn.code.length), fn.code);
  parts.push(Buffer.from([routeDefs.length]));
  for (const d of routeDefs) {
    parts.push(Buffer.from([d.style, d.params.length]));
    for (const [n, ca] of d.params) parts.push(u16(n), Buffer.from([ca]));
    if (d.style === 0) parts.push(u16(d.nodeFn));
    else { parts.push(Buffer.from([d.methods.length])); for (const [m, fi] of d.methods) parts.push(Buffer.from([m]), u16(fi)); }
  }
  return Buffer.concat(parts);
}
