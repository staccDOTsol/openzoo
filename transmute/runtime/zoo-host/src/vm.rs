//! The bytecode interpreter of the shared runtime.
//!
//! A site's code is a module (see `Module::parse`) produced by
//! `lib/compile/bytecode.js` from the same IR the Rust backend prints. The
//! machine is a value stack over `Val`; functions have flat local slots;
//! callbacks, local closures and try bodies are inline regions of their
//! parent function that share its locals and get their own `args`.
use crate::helpers;
use crate::json;
use crate::val::{global_call, math, Val};
use crate::wire::Resp;
use crate::Ctx;
use alloc::{string::String, vec::Vec};

pub const MAGIC: &[u8; 4] = b"ZOOB";
pub const VERSION: u8 = 1;
/// Interpreter recursion limit (callbacks inside callbacks, helper calls).
const MAX_DEPTH: u32 = 24;
/// Instruction budget per invoke, so a runaway loop fails with a message
/// instead of burning the whole compute budget silently.
const MAX_STEPS: u32 = 400_000;

// ---- opcodes (keep in sync with lib/compile/bytecode.js)
pub const OP_NOP: u8 = 0;
pub const OP_PUSH_CONST: u8 = 1;
pub const OP_PUSH_UNDEF: u8 = 2;
pub const OP_PUSH_NULL: u8 = 3;
pub const OP_DUP: u8 = 4;
pub const OP_POP: u8 = 5;
pub const OP_SWAP: u8 = 6;
pub const OP_LOAD: u8 = 7;
pub const OP_STORE: u8 = 8;
pub const OP_LOAD_ARG: u8 = 9;
pub const OP_ARGS_FROM: u8 = 10;
pub const OP_NEW_OBJ: u8 = 11;
pub const OP_OBJ_SET_K: u8 = 12;
pub const OP_OBJ_SET: u8 = 13;
pub const OP_OBJ_SPREAD: u8 = 14;
pub const OP_NEW_ARR: u8 = 15;
pub const OP_ARR_PUSH: u8 = 16;
pub const OP_ARR_SPREAD: u8 = 17;
pub const OP_GET_K: u8 = 18;
pub const OP_GET: u8 = 19;
pub const OP_TEMPLATE: u8 = 20;
pub const OP_BIN: u8 = 21;
pub const OP_CMP: u8 = 22;
pub const OP_UNARY: u8 = 23;
pub const OP_IN: u8 = 24;
pub const OP_JMP: u8 = 25;
pub const OP_JF: u8 = 26;
pub const OP_JT: u8 = 27;
pub const OP_JF_KEEP: u8 = 28;
pub const OP_JT_KEEP: u8 = 29;
pub const OP_JNN_KEEP: u8 = 30;
pub const OP_JNULLISH_UNDEF: u8 = 31;
pub const OP_CALLM: u8 = 32;
pub const OP_HOST: u8 = 33;
pub const OP_HELPER: u8 = 34;
pub const OP_MATH: u8 = 35;
pub const OP_GLOBAL: u8 = 36;
pub const OP_JSON_PARSE: u8 = 37;
pub const OP_JSON_STRINGIFY: u8 = 38;
pub const OP_KEYS: u8 = 39;
pub const OP_VALUES: u8 = 40;
pub const OP_ENTRIES: u8 = 41;
pub const OP_ISARRAY: u8 = 42;
pub const OP_NEW_ERROR: u8 = 43;
pub const OP_LOG: u8 = 44;
pub const OP_RESP: u8 = 45;
pub const OP_PARAMS: u8 = 46;
pub const OP_PARAM: u8 = 47;
pub const OP_CALL_FN: u8 = 48;
pub const OP_CALL_INLINE: u8 = 49;
pub const OP_RET: u8 = 50;
pub const OP_SEND: u8 = 51;
pub const OP_THROW: u8 = 52;
pub const OP_TRY_PUSH: u8 = 53;
pub const OP_TRY_POP: u8 = 54;
pub const OP_CAUGHT: u8 = 55;
pub const OP_ITER_INIT: u8 = 56;
pub const OP_ITER_NEXT: u8 = 57;
pub const OP_STORE_PATH: u8 = 58;
pub const OP_STORE_PATH_DISCARD: u8 = 59;
pub const OP_DELETE_PATH: u8 = 60;
pub const OP_TRUTHY: u8 = 61;
pub const OP_NULLISH: u8 = 62;
pub const OP_STRICT_EQ_KEEP: u8 = 63;

// CALLM flags
const CALLM_CB: u8 = 1;
const CALLM_DEFAULT_SORT: u8 = 2;
const CALLM_MUT: u8 = 4;
// HOST flags
const HOST_Q: u8 = 1;
const HOST_VOID: u8 = 2;

pub struct Func<'m> {
    pub nlocals: u16,
    pub code: &'m [u8],
}

pub struct RouteDef {
    pub style: u8, // 0 node, 1 web
    pub params: Vec<(String, bool)>,
    pub node_fn: u16,
    pub methods: Vec<(u8, u16)>,
}

pub struct Module<'m> {
    pub consts: Vec<Val>,
    pub env: Vec<(String, String)>,
    pub funcs: Vec<Func<'m>>,
    pub routes: Vec<RouteDef>,
}

struct R<'m> {
    b: &'m [u8],
    i: usize,
}
impl<'m> R<'m> {
    fn u8(&mut self) -> Result<u8, ()> {
        let v = *self.b.get(self.i).ok_or(())?;
        self.i += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16, ()> {
        let s = self.b.get(self.i..self.i + 2).ok_or(())?;
        self.i += 2;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Result<u32, ()> {
        let s = self.b.get(self.i..self.i + 4).ok_or(())?;
        self.i += 4;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn bytes(&mut self, n: usize) -> Result<&'m [u8], ()> {
        let s = self.b.get(self.i..self.i + n).ok_or(())?;
        self.i += n;
        Ok(s)
    }
}

impl<'m> Module<'m> {
    pub fn parse(b: &'m [u8]) -> Result<Module<'m>, ()> {
        let mut r = R { b, i: 0 };
        if r.bytes(4)? != MAGIC || r.u8()? != VERSION {
            return Err(());
        }
        let nc = r.u16()? as usize;
        let mut consts = Vec::with_capacity(nc);
        for _ in 0..nc {
            consts.push(match r.u8()? {
                0 => Val::Undef,
                1 => Val::Null,
                2 => Val::Bool(false),
                3 => Val::Bool(true),
                4 => {
                    let s = r.bytes(8)?;
                    let mut a = [0u8; 8];
                    a.copy_from_slice(s);
                    Val::Num(f64::from_le_bytes(a))
                }
                5 => {
                    let n = r.u32()? as usize;
                    Val::Str(String::from(core::str::from_utf8(r.bytes(n)?).map_err(|_| ())?))
                }
                _ => return Err(()),
            });
        }
        let ne = r.u16()? as usize;
        let mut env = Vec::with_capacity(ne);
        for _ in 0..ne {
            let k = consts.get(r.u16()? as usize).ok_or(())?.to_js_string();
            let v = consts.get(r.u16()? as usize).ok_or(())?.to_js_string();
            env.push((k, v));
        }
        let nf = r.u16()? as usize;
        let mut funcs = Vec::with_capacity(nf);
        for _ in 0..nf {
            let nlocals = r.u16()?;
            let len = r.u32()? as usize;
            funcs.push(Func { nlocals, code: r.bytes(len)? });
        }
        let nr = r.u8()? as usize;
        let mut routes = Vec::with_capacity(nr);
        for _ in 0..nr {
            let style = r.u8()?;
            let np = r.u8()? as usize;
            let mut params = Vec::with_capacity(np);
            for _ in 0..np {
                let name = consts.get(r.u16()? as usize).ok_or(())?.to_js_string();
                let ca = r.u8()? != 0;
                params.push((name, ca));
            }
            let mut node_fn = 0;
            let mut methods = Vec::new();
            if style == 0 {
                node_fn = r.u16()?;
            } else {
                let nm = r.u8()? as usize;
                for _ in 0..nm {
                    let m = r.u8()?;
                    let f = r.u16()?;
                    methods.push((m, f));
                }
            }
            routes.push(RouteDef { style, params, node_fn, methods });
        }
        Ok(Module { consts, env, funcs, routes })
    }
}

struct Frame {
    locals: Vec<Val>,
    tries: Vec<(usize, usize)>, // (handler pc, stack depth)
}

pub struct Vm<'m, 'c, 'a> {
    m: &'m Module<'m>,
    cx: &'c mut Ctx<'a>,
    stack: Vec<Val>,
    route: usize,
    depth: u32,
    steps: u32,
}

fn err(s: &str) -> Val {
    Val::str(s)
}

/// Run one route of a module for the request already in `cx`.
pub fn run_route(m: &Module, cx: &mut Ctx, route: usize) -> Result<(), Val> {
    let r = m.routes.get(route).ok_or_else(|| err("no such route"))?;
    let mut vm = Vm { m, cx, stack: Vec::with_capacity(32), route, depth: 0, steps: 0 };
    if r.style == 0 {
        vm.call_fn(r.node_fn, Vec::new())?;
        return Ok(());
    }
    let method = vm.cx.req.method; // 0 GET 1 POST 2 PUT 3 DELETE 4 PATCH 5 OPTIONS 6 HEAD
    let mut target = r.methods.iter().find(|(mm, _)| *mm == method).map(|(_, f)| *f);
    if target.is_none() && method == 6 {
        target = r.methods.iter().find(|(mm, _)| *mm == 0).map(|(_, f)| *f);
    }
    match target {
        Some(f) => {
            vm.call_fn(f, Vec::new())?;
            Ok(())
        }
        None => {
            let mut allow = String::new();
            for (i, (mm, _)) in r.methods.iter().enumerate() {
                if i > 0 {
                    allow.push_str(", ");
                }
                allow.push_str(crate::wire::METHODS.get(*mm as usize).copied().unwrap_or("GET"));
            }
            if r.methods.iter().any(|(mm, _)| *mm == 0) && !r.methods.iter().any(|(mm, _)| *mm == 6) {
                allow.push_str(", HEAD");
            }
            if !r.methods.iter().any(|(mm, _)| *mm == 5) {
                allow.push_str(", OPTIONS");
            }
            let status = if method == 5 { 204.0 } else { 405.0 };
            vm.cx.res_status(&Val::Num(status));
            vm.cx.res_header(&Val::str("allow"), &Val::Str(allow));
            vm.cx.res_end(&Val::Undef);
            Ok(())
        }
    }
}

impl<'m, 'c, 'a> Vm<'m, 'c, 'a> {
    fn call_fn(&mut self, fi: u16, args: Vec<Val>) -> Result<Val, Val> {
        let f = self.m.funcs.get(fi as usize).ok_or_else(|| err("bad function index"))?;
        if self.depth >= MAX_DEPTH {
            return Err(err("RangeError: Maximum call stack size exceeded"));
        }
        self.depth += 1;
        let mut frame = Frame { locals: alloc::vec![Val::Undef; f.nlocals as usize], tries: Vec::new() };
        let r = self.exec(fi, &mut frame, 0, &args);
        self.depth -= 1;
        r
    }

    fn pop(&mut self) -> Result<Val, Val> {
        self.stack.pop().ok_or_else(|| err("vm: stack underflow"))
    }

    fn pop_n(&mut self, n: usize) -> Result<Vec<Val>, Val> {
        if self.stack.len() < n {
            return Err(err("vm: stack underflow"));
        }
        Ok(self.stack.split_off(self.stack.len() - n))
    }

    fn konst(&self, i: u16) -> Result<Val, Val> {
        self.m.consts.get(i as usize).cloned().ok_or_else(|| err("vm: bad constant"))
    }

    fn kstr(&self, i: u16) -> Result<String, Val> {
        Ok(self.konst(i)?.to_js_string())
    }

    /// Execute from `pc` until RET. Errors thrown inside are routed to the
    /// innermost handler pushed within this region; otherwise they propagate.
    fn exec(&mut self, fi: u16, frame: &mut Frame, start: usize, args: &[Val]) -> Result<Val, Val> {
        let code = self.m.funcs[fi as usize].code;
        let try_base = frame.tries.len();
        let mut pc = start;
        loop {
            match self.step(fi, frame, &mut pc, args, code) {
                Ok(Some(v)) => {
                    frame.tries.truncate(try_base);
                    return Ok(v);
                }
                Ok(None) => {}
                Err(e) => {
                    if frame.tries.len() > try_base {
                        let (handler, depth) = frame.tries.pop().unwrap();
                        self.stack.truncate(depth);
                        self.stack.push(e);
                        pc = handler;
                    } else {
                        frame.tries.truncate(try_base);
                        return Err(e);
                    }
                }
            }
        }
    }

    #[inline(always)]
    fn rd_u8(code: &[u8], pc: &mut usize) -> Result<u8, Val> {
        let v = *code.get(*pc).ok_or_else(|| err("vm: truncated code"))?;
        *pc += 1;
        Ok(v)
    }
    #[inline(always)]
    fn rd_u16(code: &[u8], pc: &mut usize) -> Result<u16, Val> {
        let s = code.get(*pc..*pc + 2).ok_or_else(|| err("vm: truncated code"))?;
        *pc += 2;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    #[inline(always)]
    fn rd_i32(code: &[u8], pc: &mut usize) -> Result<i32, Val> {
        let s = code.get(*pc..*pc + 4).ok_or_else(|| err("vm: truncated code"))?;
        *pc += 4;
        Ok(i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    #[inline(always)]
    fn rd_u32(code: &[u8], pc: &mut usize) -> Result<u32, Val> {
        Ok(Self::rd_i32(code, pc)? as u32)
    }

    fn jump(pc: &mut usize, off: i32) {
        *pc = (*pc as i64 + off as i64) as usize;
    }

    /// One instruction. `Ok(Some(v))` = the region returned `v`.
    fn step(&mut self, fi: u16, frame: &mut Frame, pc: &mut usize, args: &[Val], code: &[u8]) -> Result<Option<Val>, Val> {
        self.steps += 1;
        if self.steps > MAX_STEPS {
            return Err(err("RangeError: instruction budget exceeded"));
        }
        let op = Self::rd_u8(code, pc)?;
        match op {
            OP_NOP => {}
            OP_PUSH_CONST => {
                let i = Self::rd_u16(code, pc)?;
                let v = self.konst(i)?;
                self.stack.push(v);
            }
            OP_PUSH_UNDEF => self.stack.push(Val::Undef),
            OP_PUSH_NULL => self.stack.push(Val::Null),
            OP_DUP => {
                let v = self.stack.last().cloned().ok_or_else(|| err("vm: stack underflow"))?;
                self.stack.push(v);
            }
            OP_POP => {
                self.pop()?;
            }
            OP_SWAP => {
                let n = self.stack.len();
                if n < 2 {
                    return Err(err("vm: stack underflow"));
                }
                self.stack.swap(n - 1, n - 2);
            }
            OP_LOAD => {
                let i = Self::rd_u16(code, pc)? as usize;
                let v = frame.locals.get(i).cloned().ok_or_else(|| err("vm: bad local"))?;
                self.stack.push(v);
            }
            OP_STORE => {
                let i = Self::rd_u16(code, pc)? as usize;
                let v = self.pop()?;
                *frame.locals.get_mut(i).ok_or_else(|| err("vm: bad local"))? = v;
            }
            OP_LOAD_ARG => {
                let i = Self::rd_u8(code, pc)? as usize;
                self.stack.push(args.get(i).cloned().unwrap_or(Val::Undef));
            }
            OP_ARGS_FROM => {
                let i = Self::rd_u8(code, pc)? as usize;
                self.stack.push(Val::Arr(args.iter().skip(i).cloned().collect()));
            }
            OP_NEW_OBJ => self.stack.push(Val::obj()),
            OP_OBJ_SET_K => {
                let k = Self::rd_u16(code, pc)?;
                let v = self.pop()?;
                let key = self.kstr(k)?;
                let o = self.stack.last_mut().ok_or_else(|| err("vm: stack underflow"))?;
                o.set_str(&key, v);
            }
            OP_OBJ_SET => {
                let v = self.pop()?;
                let k = self.pop()?;
                let o = self.stack.last_mut().ok_or_else(|| err("vm: stack underflow"))?;
                o.set(&k, v);
            }
            OP_OBJ_SPREAD => {
                let src = self.pop()?;
                let o = self.stack.last_mut().ok_or_else(|| err("vm: stack underflow"))?;
                if let Val::Obj(kv) = src {
                    for (k, v) in kv {
                        o.set_str(&k, v);
                    }
                }
            }
            OP_NEW_ARR => self.stack.push(Val::arr()),
            OP_ARR_PUSH => {
                let v = self.pop()?;
                let a = self.stack.last_mut().ok_or_else(|| err("vm: stack underflow"))?;
                a.push(v);
            }
            OP_ARR_SPREAD => {
                let src = self.pop()?;
                let a = self.stack.last_mut().ok_or_else(|| err("vm: stack underflow"))?;
                for v in src.iter_values() {
                    a.push(v);
                }
            }
            OP_GET_K => {
                let k = Self::rd_u16(code, pc)?;
                let key = self.kstr(k)?;
                let o = self.pop()?;
                self.stack.push(o.get_str(&key));
            }
            OP_GET => {
                let k = self.pop()?;
                let o = self.pop()?;
                self.stack.push(o.get(&k));
            }
            OP_TEMPLATE => {
                let n = Self::rd_u8(code, pc)? as usize;
                let parts = self.pop_n(n)?;
                let mut s = String::new();
                for p in parts.iter() {
                    s.push_str(&p.to_js_string());
                }
                self.stack.push(Val::Str(s));
            }
            OP_BIN => {
                let o = Self::rd_u8(code, pc)?;
                let r = self.pop()?;
                let l = self.pop()?;
                self.stack.push(match o {
                    0 => l.add(&r),
                    1 => l.sub(&r),
                    2 => l.mul(&r),
                    3 => l.div(&r),
                    4 => l.rem(&r),
                    5 => l.pow(&r),
                    6 => l.bit_and(&r),
                    7 => l.bit_or(&r),
                    8 => l.bit_xor(&r),
                    9 => l.shl(&r),
                    10 => l.shr(&r),
                    11 => l.ushr(&r),
                    _ => return Err(err("vm: bad binary op")),
                });
            }
            OP_CMP => {
                let o = Self::rd_u8(code, pc)?;
                let r = self.pop()?;
                let l = self.pop()?;
                self.stack.push(Val::Bool(cmp(o, &l, &r)?));
            }
            OP_STRICT_EQ_KEEP => {
                // switch: [disc, case] -> [disc, Bool]
                let c = self.pop()?;
                let d = self.stack.last().ok_or_else(|| err("vm: stack underflow"))?;
                let b = d.strict_eq(&c);
                self.stack.push(Val::Bool(b));
            }
            OP_UNARY => {
                let o = Self::rd_u8(code, pc)?;
                let v = self.pop()?;
                self.stack.push(match o {
                    0 => v.neg(),
                    1 => Val::Num(v.to_num()),
                    2 => Val::Bool(!v.truthy()),
                    3 => v.bit_xor(&Val::Num(-1.0)),
                    4 => Val::str(v.type_of()),
                    5 => Val::Undef,
                    _ => return Err(err("vm: bad unary op")),
                });
            }
            OP_TRUTHY => {
                let v = self.pop()?;
                self.stack.push(Val::Bool(v.truthy()));
            }
            OP_NULLISH => {
                let v = self.pop()?;
                self.stack.push(Val::Bool(v.is_nullish()));
            }
            OP_IN => {
                let o = self.pop()?;
                let k = self.pop()?;
                self.stack.push(Val::Bool(o.has(&k)));
            }
            OP_JMP => {
                let off = Self::rd_i32(code, pc)?;
                Self::jump(pc, off);
            }
            OP_JF => {
                let off = Self::rd_i32(code, pc)?;
                if !self.pop()?.truthy() {
                    Self::jump(pc, off);
                }
            }
            OP_JT => {
                let off = Self::rd_i32(code, pc)?;
                if self.pop()?.truthy() {
                    Self::jump(pc, off);
                }
            }
            OP_JF_KEEP => {
                let off = Self::rd_i32(code, pc)?;
                let t = self.stack.last().map(|v| v.truthy()).ok_or_else(|| err("vm: stack underflow"))?;
                if !t {
                    Self::jump(pc, off);
                } else {
                    self.pop()?;
                }
            }
            OP_JT_KEEP => {
                let off = Self::rd_i32(code, pc)?;
                let t = self.stack.last().map(|v| v.truthy()).ok_or_else(|| err("vm: stack underflow"))?;
                if t {
                    Self::jump(pc, off);
                } else {
                    self.pop()?;
                }
            }
            OP_JNN_KEEP => {
                let off = Self::rd_i32(code, pc)?;
                let nn = self.stack.last().map(|v| !v.is_nullish()).ok_or_else(|| err("vm: stack underflow"))?;
                if nn {
                    Self::jump(pc, off);
                } else {
                    self.pop()?;
                }
            }
            OP_JNULLISH_UNDEF => {
                let off = Self::rd_i32(code, pc)?;
                let n = self.stack.last().map(|v| v.is_nullish()).ok_or_else(|| err("vm: stack underflow"))?;
                if n {
                    self.pop()?;
                    self.stack.push(Val::Undef);
                    Self::jump(pc, off);
                }
            }
            OP_CALLM => {
                let name_k = Self::rd_u16(code, pc)?;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let flags = Self::rd_u8(code, pc)?;
                let cb_off = if flags & CALLM_CB != 0 { Some(Self::rd_u32(code, pc)? as usize) } else { None };
                let name = self.kstr(name_k)?;
                let cargs = self.pop_n(nargs)?;
                let mut recv = self.pop()?;
                let mut cb_err: Option<Val> = None;
                let out = if let Some(off) = cb_off {
                    let mut f = |a: &[Val]| -> Val {
                        if cb_err.is_some() {
                            return Val::Undef;
                        }
                        match self.call_inline(fi, frame, off, a) {
                            Ok(v) => v,
                            Err(e) => {
                                cb_err = Some(e);
                                Val::Undef
                            }
                        }
                    };
                    recv.call(&name, &cargs, Some(&mut f))
                } else if flags & CALLM_DEFAULT_SORT != 0 {
                    let mut f = |a: &[Val]| -> Val {
                        let x = a.first().map(|v| v.to_js_string()).unwrap_or_default();
                        let y = a.get(1).map(|v| v.to_js_string()).unwrap_or_default();
                        Val::Num(if x < y { -1.0 } else if x > y { 1.0 } else { 0.0 })
                    };
                    recv.call(&name, &cargs, Some(&mut f))
                } else {
                    recv.call(&name, &cargs, None)
                };
                if let Some(e) = cb_err {
                    return Err(e);
                }
                let out = out?;
                if flags & CALLM_MUT != 0 {
                    self.stack.push(out);
                    self.stack.push(recv);
                } else {
                    self.stack.push(out);
                }
            }
            OP_HOST => {
                let id = Self::rd_u8(code, pc)?;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let flags = Self::rd_u8(code, pc)?;
                let a = self.pop_n(nargs)?;
                let v = self.host(id, &a, flags & HOST_Q != 0)?;
                self.stack.push(if flags & HOST_VOID != 0 { Val::Undef } else { v });
            }
            OP_HELPER => {
                let id = Self::rd_u8(code, pc)?;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let a = self.pop_n(nargs)?;
                let v = helpers::helper(self.cx, id, &a);
                self.stack.push(v);
            }
            OP_MATH => {
                let k = Self::rd_u16(code, pc)?;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let a = self.pop_n(nargs)?;
                let name = self.kstr(k)?;
                self.stack.push(math(&name, &a)?);
            }
            OP_GLOBAL => {
                let k = Self::rd_u16(code, pc)?;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let a = self.pop_n(nargs)?;
                let name = self.kstr(k)?;
                self.stack.push(global_call(&name, &a)?);
            }
            OP_JSON_PARSE => {
                let s = self.pop()?;
                self.stack.push(json::parse(&s.to_js_string())?);
            }
            OP_JSON_STRINGIFY => {
                let v = self.pop()?;
                self.stack.push(Val::Str(json::stringify(&v)));
            }
            OP_KEYS => {
                let v = self.pop()?;
                self.stack.push(v.keys());
            }
            OP_VALUES => {
                let v = self.pop()?;
                self.stack.push(v.values());
            }
            OP_ENTRIES => {
                let v = self.pop()?;
                self.stack.push(v.entries());
            }
            OP_ISARRAY => {
                let v = self.pop()?;
                self.stack.push(Val::Bool(matches!(v, Val::Arr(_))));
            }
            OP_NEW_ERROR => {
                let k = Self::rd_u16(code, pc)?;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let a = self.pop_n(nargs)?;
                let name = self.kstr(k)?;
                let mut e = Ctx::new_error(&a);
                if name != "Error" {
                    e.set_str("name", Val::Str(name));
                }
                self.stack.push(e);
            }
            OP_LOG => {
                let nargs = Self::rd_u8(code, pc)? as usize;
                let a = self.pop_n(nargs)?;
                helpers::log(&a);
                self.stack.push(Val::Undef);
            }
            OP_RESP => {
                let k = Self::rd_u16(code, pc)?;
                let init = self.pop()?;
                let body = self.pop()?;
                let kind = self.kstr(k)?;
                self.stack.push(helpers::resp(&kind, body, init));
            }
            OP_PARAMS => {
                let kind = Self::rd_u8(code, pc)?;
                let route = &self.m.routes[self.route];
                let ps: Vec<(&str, bool)> = route.params.iter().map(|(n, c)| (n.as_str(), *c)).collect();
                let v = if kind == 0 { helpers::query(self.cx, &ps) } else { helpers::params(self.cx, &ps) };
                self.stack.push(v);
            }
            OP_PARAM => {
                let k = Self::rd_u16(code, pc)?;
                let ca = Self::rd_u8(code, pc)? != 0;
                let name = self.kstr(k)?;
                let v = helpers::param(self.cx, &name, ca);
                self.stack.push(v);
            }
            OP_CALL_FN => {
                let f = Self::rd_u16(code, pc)?;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let a = self.pop_n(nargs)?;
                let v = self.call_fn(f, a)?;
                self.stack.push(v);
            }
            OP_CALL_INLINE => {
                let off = Self::rd_u32(code, pc)? as usize;
                let nargs = Self::rd_u8(code, pc)? as usize;
                let a = self.pop_n(nargs)?;
                let v = self.call_inline(fi, frame, off, &a)?;
                self.stack.push(v);
            }
            OP_RET => {
                let v = self.pop()?;
                return Ok(Some(v));
            }
            OP_SEND => {
                let v = self.pop()?;
                helpers::send(self.cx, &v)?;
            }
            OP_THROW => {
                let v = self.pop()?;
                return Err(v);
            }
            OP_TRY_PUSH => {
                let off = Self::rd_i32(code, pc)?;
                let handler = (*pc as i64 + off as i64) as usize;
                frame.tries.push((handler, self.stack.len()));
            }
            OP_TRY_POP => {
                frame.tries.pop();
            }
            OP_CAUGHT => {
                let e = self.pop()?;
                self.stack.push(helpers::caught(e));
            }
            OP_ITER_INIT => {
                let arr_l = Self::rd_u16(code, pc)? as usize;
                let idx_l = Self::rd_u16(code, pc)? as usize;
                let it = self.pop()?;
                let snapshot = Val::Arr(it.iter_values());
                *frame.locals.get_mut(arr_l).ok_or_else(|| err("vm: bad local"))? = snapshot;
                *frame.locals.get_mut(idx_l).ok_or_else(|| err("vm: bad local"))? = Val::Num(0.0);
            }
            OP_ITER_NEXT => {
                let arr_l = Self::rd_u16(code, pc)? as usize;
                let idx_l = Self::rd_u16(code, pc)? as usize;
                let out_l = Self::rd_u16(code, pc)? as usize;
                let off = Self::rd_i32(code, pc)?;
                let idx = frame.locals.get(idx_l).map(|v| v.to_num()).unwrap_or(0.0) as usize;
                let item = match frame.locals.get(arr_l) {
                    Some(Val::Arr(a)) => a.get(idx).cloned(),
                    _ => None,
                };
                match item {
                    Some(v) => {
                        *frame.locals.get_mut(out_l).ok_or_else(|| err("vm: bad local"))? = v;
                        *frame.locals.get_mut(idx_l).ok_or_else(|| err("vm: bad local"))? = Val::Num((idx + 1) as f64);
                    }
                    None => Self::jump(pc, off),
                }
            }
            OP_STORE_PATH => {
                let root = Self::rd_u16(code, pc)? as usize;
                let nkeys = Self::rd_u8(code, pc)? as usize;
                let keys = self.pop_n(nkeys)?;
                let value = self.pop()?;
                let base = frame.locals.get_mut(root).ok_or_else(|| err("vm: bad local"))?;
                set_path(base, &keys, value);
            }
            OP_STORE_PATH_DISCARD => {
                let nkeys = Self::rd_u8(code, pc)? as usize;
                let _keys = self.pop_n(nkeys)?;
                let _base = self.pop()?;
                let _value = self.pop()?;
            }
            OP_DELETE_PATH => {
                let root = Self::rd_u16(code, pc)? as usize;
                let nkeys = Self::rd_u8(code, pc)? as usize;
                let keys = self.pop_n(nkeys)?;
                let base = frame.locals.get_mut(root).ok_or_else(|| err("vm: bad local"))?;
                delete_path(base, &keys);
                self.stack.push(Val::Bool(true));
            }
            _ => return Err(err("vm: unknown opcode")),
        }
        Ok(None)
    }

    fn call_inline(&mut self, fi: u16, frame: &mut Frame, off: usize, args: &[Val]) -> Result<Val, Val> {
        if self.depth >= MAX_DEPTH {
            return Err(err("RangeError: Maximum call stack size exceeded"));
        }
        self.depth += 1;
        let r = self.exec(fi, frame, off, args);
        self.depth -= 1;
        r
    }

    fn host(&mut self, id: u8, a: &[Val], _q: bool) -> Result<Val, Val> {
        let arg = |i: usize| a.get(i).cloned().unwrap_or(Val::Undef);
        let cx = &mut *self.cx;
        Ok(match id {
            0 => cx.req_method(),
            1 => cx.req_path(),
            2 => cx.req_url(),
            3 => cx.req_full_url(),
            4 => cx.req_query(),
            5 => cx.req_query_get(&arg(0)),
            6 => cx.req_headers(),
            7 => cx.req_header(&arg(0)),
            8 => cx.req_text(),
            9 => cx.req_body(),
            10 => cx.req_json()?,
            11 => { cx.res_status(&arg(0)); Val::Undef }
            12 => { cx.res_header(&arg(0), &arg(1)); Val::Undef }
            13 => { cx.res_json(&arg(0)); Val::Undef }
            14 => { cx.res_send(&arg(0)); Val::Undef }
            15 => { cx.res_end(&arg(0)); Val::Undef }
            16 => { cx.res_redirect(&arg(0), &arg(1)); Val::Undef }
            17 => cx.env(&arg(0)),
            18 => cx.env_obj(),
            19 => cx.now_ms(),
            20 => cx.now_iso(),
            21 => cx.kv_get(&arg(0))?,
            22 => cx.kv_exists(&arg(0))?,
            23 => cx.kv_set(&arg(0), &arg(1))?,
            24 => cx.kv_incrby(&arg(0), &arg(1))?,
            25 => cx.kv_del(&arg(0))?,
            26 => cx.slot(),
            27 => cx.payer_address(),
            28 => cx.program_address(),
            _ => return Err(err("vm: unknown host call")),
        })
    }
}

fn cmp(op: u8, l: &Val, r: &Val) -> Result<bool, Val> {
    Ok(match op {
        0 => l.strict_eq(r),
        1 => !l.strict_eq(r),
        2 => l.loose_eq(r),
        3 => !l.loose_eq(r),
        4 => l.lt(r),
        5 => l.le(r),
        6 => l.gt(r),
        7 => l.ge(r),
        _ => return Err(err("vm: bad compare")),
    })
}

fn set_path(base: &mut Val, keys: &[Val], value: Val) {
    if keys.is_empty() {
        *base = value;
        return;
    }
    let mut cur = base.get(&keys[0]);
    set_path(&mut cur, &keys[1..], value);
    base.set(&keys[0], cur);
}

fn delete_path(base: &mut Val, keys: &[Val]) {
    match keys.len() {
        0 => {}
        1 => base.delete(&keys[0]),
        _ => {
            let mut cur = base.get(&keys[0]);
            delete_path(&mut cur, &keys[1..]);
            base.set(&keys[0], cur);
        }
    }
}

/// Entry for the shared runtime: parse the module, set the site namespace and
/// env, run the route, emit the response (same envelope as `dispatch`).
pub fn invoke_module(cx: &mut Ctx, code: &[u8], route: usize) -> Result<(), Val> {
    let m = Module::parse(code).map_err(|_| err("vm: malformed module"))?;
    cx.env_dyn = m.env.clone();
    run_route(&m, cx, route)
}

/// Compose the 500 for an uncaught throw (mirrors lib.rs).
pub fn error_resp(thrown: &Val) -> Resp {
    let msg: String = match thrown {
        Val::Obj(_) => match thrown.get_str("message") {
            Val::Undef => thrown.to_js_string(),
            m => m.to_js_string(),
        },
        _ => thrown.to_js_string(),
    };
    Resp::json_error(500, &msg)
}
