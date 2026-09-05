//! Bridge helpers shared by compiled sites (the generated prelude calls
//! these) and the bytecode interpreter (by id).
use crate::json;
use crate::val::{url_decode, Val};
use crate::Ctx;
use alloc::{string::String, vec::Vec};

/// Response value for app-router handlers: a tagged object `send` turns into
/// the bridge response.
pub fn resp(kind: &str, a: Val, b: Val) -> Val {
    let mut o = Val::obj();
    o.set_str("__zoo", Val::str(kind));
    o.set_str("a", a);
    o.set_str("b", b);
    o
}

pub fn send(cx: &mut Ctx, v: &Val) -> Result<(), Val> {
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
        _ => if v.is_undef() { Ok(()) } else { Err(Val::str("TypeError: the handler returned a value that is not a Response")) },
    }
}

/// Runtime throws are strings ("SyntaxError: ..."); in a catch they become
/// Error-like objects so `e.message` / `e.name` read as in Node.
pub fn caught(v: Val) -> Val {
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

pub fn param_value(s: &str, catch_all: bool) -> Val {
    if catch_all {
        Val::Arr(s.split('/').filter(|p| !p.is_empty()).map(|p| Val::Str(url_decode(p))).collect())
    } else {
        Val::Str(url_decode(s))
    }
}

/// A dynamic segment, passed by the gateway as the `x-zoo-param-<name>` header.
pub fn param(cx: &mut Ctx, name: &str, catch_all: bool) -> Val {
    let mut h = String::from("x-zoo-param-");
    h.push_str(name);
    match cx.req_header(&Val::Str(h)) {
        Val::Str(s) => param_value(&s, catch_all),
        _ => Val::Undef,
    }
}

pub fn params(cx: &mut Ctx, params: &[(&str, bool)]) -> Val {
    let mut o = Val::obj();
    for (name, catch_all) in params.iter() {
        let v = param(cx, name, *catch_all);
        if !v.is_undef() { o.set_str(name, v); }
    }
    o
}

/// `req.query`: the query string plus the route's dynamic segments.
pub fn query(cx: &mut Ctx, params: &[(&str, bool)]) -> Val {
    let mut q = cx.req_query();
    for (name, catch_all) in params.iter() {
        let v = param(cx, name, *catch_all);
        if !v.is_undef() { q.set_str(name, v); }
    }
    q
}

pub fn cookies(cx: &mut Ctx) -> Val {
    let mut o = Val::obj();
    if let Val::Str(h) = cx.req_header(&Val::str("cookie")) {
        for part in h.split(';') {
            let p = part.trim();
            if let Some(i) = p.find('=') { o.set_str(&p[..i], Val::Str(url_decode(&p[i + 1..]))); }
        }
    }
    o
}

pub fn log(a: &[Val]) -> Val {
    let mut s = String::new();
    for (i, v) in a.iter().enumerate() {
        if i > 0 { s.push(' '); }
        match v {
            Val::Str(x) => s.push_str(x),
            Val::Obj(_) | Val::Arr(_) => s.push_str(&json::stringify(v)),
            other => s.push_str(&other.to_js_string()),
        }
    }
    crate::wire::log_str(&s);
    Val::Undef
}

/// Helper ids shared with the bytecode emitter (lib/compile/bytecode.js).
pub const H_COOKIES: u8 = 0;
pub const H_COOKIE_GET: u8 = 1;
pub const H_COOKIE_HAS: u8 = 2;
pub const H_COOKIE_ALL: u8 = 3;
pub const H_HEADER_HAS: u8 = 4;
pub const H_QUERY_HAS: u8 = 5;
pub const H_QUERY_GET_ALL: u8 = 6;
pub const H_SEARCH: u8 = 7;
pub const H_ASSIGN: u8 = 8;
pub const H_OMIT: u8 = 9;
pub const H_FROM_ENTRIES: u8 = 10;
pub const H_ARRAY_FROM: u8 = 11;
pub const H_SLICE_FROM: u8 = 12;
pub const H_URL: u8 = 13;
pub const H_NUM: u8 = 14;
pub const H_SET_HEADERS: u8 = 15;

pub fn helper_id(name: &str) -> Option<u8> {
    Some(match name {
        "cookies" => H_COOKIES, "cookie_get" => H_COOKIE_GET, "cookie_has" => H_COOKIE_HAS, "cookie_all" => H_COOKIE_ALL,
        "header_has" => H_HEADER_HAS, "query_has" => H_QUERY_HAS, "query_get_all" => H_QUERY_GET_ALL, "search" => H_SEARCH,
        "assign" => H_ASSIGN, "omit" => H_OMIT, "from_entries" => H_FROM_ENTRIES, "array_from" => H_ARRAY_FROM,
        "slice_from" => H_SLICE_FROM, "url" => H_URL, "num" => H_NUM, "set_headers" => H_SET_HEADERS,
        _ => return None,
    })
}

pub fn helper(cx: &mut Ctx, id: u8, a: &[Val]) -> Val {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Val::Undef);
    match id {
        H_COOKIES => cookies(cx),
        H_COOKIE_GET => {
            let name = arg(0);
            let v = cookies(cx).get(&name);
            if v.is_undef() { return Val::Undef; }
            let mut o = Val::obj();
            o.set_str("name", name);
            o.set_str("value", v);
            o
        }
        H_COOKIE_HAS => Val::Bool(cookies(cx).has(&arg(0))),
        H_COOKIE_ALL => {
            let mut out = Val::arr();
            if let Val::Obj(kv) = cookies(cx) {
                for (k, v) in kv {
                    let mut o = Val::obj();
                    o.set_str("name", Val::Str(k));
                    o.set_str("value", v);
                    out.push(o);
                }
            }
            out
        }
        H_HEADER_HAS => Val::Bool(!cx.req_header(&arg(0)).is_nullish()),
        H_QUERY_HAS => Val::Bool(cx.req_query().has(&arg(0))),
        H_QUERY_GET_ALL => match cx.req_query_get(&arg(0)) {
            Val::Null | Val::Undef => Val::arr(),
            v => Val::Arr(alloc::vec![v]),
        },
        H_SEARCH => {
            let with_q = arg(0).truthy();
            let u = cx.req_url().to_js_string();
            match u.find('?') {
                Some(i) => Val::Str(String::from(if with_q { &u[i..] } else { &u[i + 1..] })),
                None => Val::str(""),
            }
        }
        H_ASSIGN => {
            let mut t = if a.is_empty() { Val::obj() } else { arg(0) };
            for src in a.iter().skip(1) {
                if let Val::Obj(kv) = src { for (k, v) in kv.iter() { t.set_str(k, v.clone()); } }
            }
            t
        }
        H_OMIT => {
            let mut out = Val::obj();
            let skip: Vec<String> = arg(1).iter_values().iter().map(|k| k.to_js_string()).collect();
            if let Val::Obj(kv) = arg(0) {
                for (k, v) in kv.iter() { if !skip.iter().any(|s| s == k) { out.set_str(k, v.clone()); } }
            }
            out
        }
        H_FROM_ENTRIES => {
            let mut o = Val::obj();
            for pair in arg(0).iter_values() {
                let k = pair.get(&Val::Num(0.0));
                let v = pair.get(&Val::Num(1.0));
                o.set(&k, v);
            }
            o
        }
        H_ARRAY_FROM => Val::Arr(arg(0).iter_values()),
        H_SLICE_FROM => {
            let items = arg(0).iter_values();
            let from = arg(1).to_num().max(0.0) as usize;
            Val::Arr(items.into_iter().skip(from).collect())
        }
        H_URL => {
            let input = arg(0).to_js_string();
            let base = if arg(1).is_undef() { String::new() } else { arg(1).to_js_string() };
            if input.contains("://") || base.is_empty() { return Val::Str(input); }
            let origin_end = match base.find("://") {
                Some(i) => base[i + 3..].find('/').map(|j| i + 3 + j).unwrap_or(base.len()),
                None => 0,
            };
            let mut out = String::new();
            if input.starts_with('/') { out.push_str(&base[..origin_end]); out.push_str(&input); return Val::Str(out); }
            let path_end = base.rfind('/').map(|i| i + 1).unwrap_or(base.len()).max(origin_end).min(base.len());
            out.push_str(&base[..path_end]);
            out.push_str(&input);
            Val::Str(out)
        }
        H_NUM => {
            let name = arg(0).to_js_string();
            let n = match a.get(1) { Some(Val::Num(n)) => *n, _ => return Val::Bool(false) };
            Val::Bool(match name.as_str() {
                "isInteger" => n.is_finite() && n == libm::trunc(n),
                "isNaN" => n.is_nan(),
                "isFinite" => n.is_finite(),
                "isSafeInteger" => n.is_finite() && n == libm::trunc(n) && libm::fabs(n) <= 9007199254740991.0,
                _ => false,
            })
        }
        H_SET_HEADERS => {
            if let Val::Obj(kv) = arg(0) {
                for (k, v) in kv.iter() { cx.res_header(&Val::str(k), v); }
            }
            Val::Undef
        }
        _ => Val::Undef,
    }
}
