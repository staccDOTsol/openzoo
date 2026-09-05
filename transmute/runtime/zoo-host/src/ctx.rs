//! Per-invocation context: the Vercel `req`/`res` pair plus the account set.
use crate::json;
use crate::kv::KvState;
use crate::val::{parse_query, Val};
use crate::wire::{Req, Resp};
use alloc::{string::String, vec::Vec};
use crate::fmt::{push_i64, push_padded};
use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address,
};

pub struct Ctx<'a> {
    pub program_id: &'a Address,
    pub accounts: &'a mut [AccountView],
    pub req: Req,
    pub res: Resp,
    pub sent: bool,
    pub env: &'a [(&'static str, &'static str)],
    /// Environment from a bytecode module (shared runtime); consulted first.
    pub env_dyn: Vec<(String, String)>,
    /// Site namespace for KV/asset seeds: `None` for a compiled site program
    /// (the program id is the namespace), `Some(site_id)` under the shared runtime.
    pub ns: Option<[u8; 32]>,
    pub kv: KvState,
    query_cache: Option<Val>,
    body_cache: Option<Val>,
}

impl<'a> Ctx<'a> {
    pub fn new(
        program_id: &'a Address,
        accounts: &'a mut [AccountView],
        req: Req,
        env: &'a [(&'static str, &'static str)],
    ) -> Self {
        Ctx {
            program_id,
            accounts,
            req,
            res: Resp::default(),
            sent: false,
            env,
            env_dyn: Vec::new(),
            ns: None,
            kv: KvState::default(),
            query_cache: None,
            body_cache: None,
        }
    }

    // ---- req ----

    pub fn req_method(&self) -> Val {
        Val::str(self.req.method_str())
    }
    pub fn req_path(&self) -> Val {
        Val::str(&self.req.path)
    }
    /// `req.url` as Node sees it: path + query.
    pub fn req_url(&self) -> Val {
        if self.req.query.is_empty() {
            Val::str(&self.req.path)
        } else {
            let mut u = String::from(self.req.path.as_str());
            u.push('?');
            u.push_str(&self.req.query);
            Val::Str(u)
        }
    }
    /// Full URL for `new URL(request.url)` in app-router handlers. The origin
    /// is synthetic; only path/search matter on chain.
    pub fn req_full_url(&self) -> Val {
        let mut u = String::from("https://zoo.sol");
        u.push_str(&self.req_url().to_js_string());
        Val::Str(u)
    }
    pub fn req_query(&mut self) -> Val {
        if self.query_cache.is_none() {
            self.query_cache = Some(parse_query(&self.req.query));
        }
        self.query_cache.clone().unwrap()
    }
    /// `searchParams.get(name)`: string or null.
    pub fn req_query_get(&mut self, name: &Val) -> Val {
        match self.req_query().get(name) {
            Val::Undef => Val::Null,
            v => v,
        }
    }
    pub fn req_headers(&self) -> Val {
        self.req.headers_val()
    }
    /// `req.headers.get(name)` / `req.headers[name]` (null when absent).
    pub fn req_header(&self, name: &Val) -> Val {
        match self.req.header(&name.to_js_string()) {
            Some(v) => Val::str(v),
            None => Val::Null,
        }
    }
    pub fn req_text(&self) -> Val {
        Val::Str(String::from_utf8_lossy(&self.req.body).into_owned())
    }
    /// `req.body` with Vercel's helper semantics: JSON when the content type
    /// says so (or the body parses), urlencoded → object, else the raw string.
    pub fn req_body(&mut self) -> Val {
        if let Some(b) = &self.body_cache {
            return b.clone();
        }
        let ct = self.req.header("content-type").unwrap_or("").to_ascii_lowercase();
        let text = String::from_utf8_lossy(&self.req.body).into_owned();
        let v = if self.req.body.is_empty() {
            Val::Undef
        } else if ct.contains("application/json") {
            json::parse(&text).unwrap_or(Val::Undef)
        } else if ct.contains("application/x-www-form-urlencoded") {
            parse_query(&text)
        } else if ct.is_empty() {
            json::parse(&text).unwrap_or(Val::Str(text))
        } else {
            Val::Str(text)
        };
        self.body_cache = Some(v.clone());
        v
    }
    /// `await request.json()`: throws on a malformed body like fetch does.
    pub fn req_json(&mut self) -> Result<Val, Val> {
        let text = String::from_utf8_lossy(&self.req.body).into_owned();
        json::parse(&text).map_err(|_| Val::str("SyntaxError: Unexpected end of JSON input"))
    }

    // ---- res (pages-router helpers) ----

    pub fn res_status(&mut self, code: &Val) {
        let n = code.to_num();
        if n.is_finite() && (100.0..1000.0).contains(&n) {
            self.res.status = n as u16;
        }
    }
    pub fn res_header(&mut self, name: &Val, value: &Val) {
        self.res.set_header(&name.to_js_string(), &value.to_js_string());
    }
    pub fn res_json(&mut self, v: &Val) {
        if !self.res.has_header("content-type") {
            self.res.set_header("content-type", "application/json; charset=utf-8");
        }
        self.res.body = json::stringify(v).into_bytes();
        self.sent = true;
    }
    pub fn res_send(&mut self, v: &Val) {
        match v {
            Val::Undef | Val::Null => {
                self.res.body.clear();
                self.sent = true;
            }
            Val::Str(s) => {
                if !self.res.has_header("content-type") {
                    self.res.set_header("content-type", "text/html; charset=utf-8");
                }
                self.res.body = s.clone().into_bytes();
                self.sent = true;
            }
            Val::Num(_) | Val::Bool(_) | Val::Arr(_) | Val::Obj(_) => self.res_json(v),
        }
    }
    pub fn res_end(&mut self, v: &Val) {
        match v {
            Val::Undef | Val::Null => {}
            other => self.res.body = other.to_js_string().into_bytes(),
        }
        self.sent = true;
    }
    pub fn res_redirect(&mut self, status: &Val, url: &Val) {
        let (code, target) = if url.is_undef() { (Val::Num(307.0), status.clone()) } else { (status.clone(), url.clone()) };
        self.res_status(&code);
        self.res.set_header("location", &target.to_js_string());
        self.sent = true;
    }

    // ---- app-router / fetch-style responses ----

    fn apply_init(&mut self, init: &Val) {
        if let Val::Obj(_) = init {
            let st = init.get_str("status");
            if !st.is_undef() {
                self.res_status(&st);
            }
            if let Val::Obj(h) = init.get_str("headers") {
                for (k, v) in h.iter() {
                    self.res.set_header(k, &v.to_js_string());
                }
            }
        }
    }
    /// `Response.json(body, init)` / `NextResponse.json(body, init)`.
    pub fn respond_json(&mut self, body: &Val, init: &Val) {
        self.apply_init(init);
        self.res_json(body);
    }
    /// `new Response(body, init)` / `new NextResponse(body, init)`.
    pub fn respond(&mut self, body: &Val, init: &Val) {
        self.apply_init(init);
        match body {
            Val::Undef | Val::Null => {
                self.res.body.clear();
            }
            other => {
                if !self.res.has_header("content-type") {
                    self.res.set_header("content-type", "text/plain; charset=utf-8");
                }
                self.res.body = other.to_js_string().into_bytes();
            }
        }
        self.sent = true;
    }
    /// `NextResponse.redirect(url, status)` / `Response.redirect`.
    pub fn respond_redirect(&mut self, url: &Val, status: &Val) {
        let code = if status.is_undef() { Val::Num(307.0) } else { status.clone() };
        self.res_redirect(&code, url);
    }

    // ---- environment / time ----

    pub fn env(&self, name: &Val) -> Val {
        let n = name.to_js_string();
        for (k, v) in self.env_dyn.iter() {
            if *k == n {
                return Val::str(v);
            }
        }
        for (k, v) in self.env.iter() {
            if *k == n {
                return Val::str(v);
            }
        }
        Val::Undef
    }
    pub fn env_obj(&self) -> Val {
        let mut o = Val::obj();
        for (k, v) in self.env_dyn.iter() {
            o.set_str(k, Val::str(v));
        }
        for (k, v) in self.env.iter() {
            o.set_str(k, Val::str(v));
        }
        o
    }
    fn clock(&self) -> Option<Clock> {
        Clock::get().ok()
    }
    /// `Date.now()`: the cluster clock, in ms. 0 off-chain (host tests).
    pub fn now_ms(&self) -> Val {
        Val::Num(self.clock().map(|c| c.unix_timestamp as f64 * 1000.0).unwrap_or(0.0))
    }
    pub fn slot(&self) -> Val {
        Val::Num(self.clock().map(|c| c.slot as f64).unwrap_or(0.0))
    }
    /// `new Date().toISOString()`.
    pub fn now_iso(&self) -> Val {
        Val::Str(iso8601(self.now_ms().to_num()))
    }

    // ---- misc helpers used by generated code ----

    pub fn throw(msg: &str) -> Val {
        Val::str(msg)
    }
    pub fn new_error(args: &[Val]) -> Val {
        let mut e = Val::obj();
        e.set_str("name", Val::str("Error"));
        e.set_str("message", Val::Str(args.first().map(|v| v.to_js_string()).unwrap_or_default()));
        e
    }
    pub fn payer_address(&self) -> Val {
        self.accounts.first().map(|a| Val::Str(base58(a.address().as_ref()))).unwrap_or(Val::Null)
    }
    pub fn accounts_len(&self) -> usize {
        self.accounts.len()
    }
    pub fn program_address(&self) -> Val {
        Val::Str(base58(self.program_id.as_ref()))
    }
}

/// ms since epoch → `YYYY-MM-DDTHH:MM:SS.mmmZ`
pub fn iso8601(ms: f64) -> String {
    let total_ms = if ms.is_finite() { ms as i64 } else { 0 };
    let secs = total_ms.div_euclid(1000);
    let milli = total_ms.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let mut out = String::new();
    push_i64(&mut out, y);
    out.push('-');
    push_padded(&mut out, m as u64, 2);
    out.push('-');
    push_padded(&mut out, d as u64, 2);
    out.push('T');
    push_padded(&mut out, (sod / 3600) as u64, 2);
    out.push(':');
    push_padded(&mut out, ((sod % 3600) / 60) as u64, 2);
    out.push(':');
    push_padded(&mut out, (sod % 60) as u64, 2);
    out.push('.');
    push_padded(&mut out, milli as u64, 3);
    out.push('Z');
    out
}


const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn base58(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut s = String::new();
    for &b in bytes {
        if b == 0 {
            s.push('1');
        } else {
            break;
        }
    }
    for &d in digits.iter().rev() {
        s.push(B58[d as usize] as char);
    }
    s
}
