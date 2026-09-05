//! A JS-semantics dynamic value. Every expression in a transmuted handler
//! evaluates to a `Val`; the operators here follow ECMAScript coercion rules
//! for the subset the transmuter accepts.
use alloc::{format, string::String, vec::Vec};
use core::cmp::Ordering;

#[derive(Clone, Debug)]
pub enum Val {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Val>),
    Obj(Vec<(String, Val)>),
}

impl Default for Val {
    fn default() -> Self {
        Val::Undef
    }
}

impl From<&str> for Val {
    fn from(s: &str) -> Self {
        Val::Str(String::from(s))
    }
}
impl From<String> for Val {
    fn from(s: String) -> Self {
        Val::Str(s)
    }
}
impl From<f64> for Val {
    fn from(n: f64) -> Self {
        Val::Num(n)
    }
}
impl From<i64> for Val {
    fn from(n: i64) -> Self {
        Val::Num(n as f64)
    }
}
impl From<bool> for Val {
    fn from(b: bool) -> Self {
        Val::Bool(b)
    }
}

/// JS Number::toString for the common cases.
pub fn num_to_string(n: f64) -> String {
    if n.is_nan() {
        return String::from("NaN");
    }
    if n.is_infinite() {
        return String::from(if n > 0.0 { "Infinity" } else { "-Infinity" });
    }
    if n == 0.0 {
        return String::from("0");
    }
    if n == libm::trunc(n) && libm::fabs(n) < 1e21 {
        return format!("{}", n as i128);
    }
    let a = libm::fabs(n);
    if !(1e-6..1e21).contains(&a) {
        // JS switches to exponent notation here; Rust's `{:e}` prints "1e-7"
        // and JS prints "1e-7" too, so mirror it (JS adds "+" for positive
        // exponents).
        let s = format!("{:e}", n);
        return match s.find('e') {
            Some(i) if !s[i + 1..].starts_with('-') => format!("{}e+{}", &s[..i], &s[i + 1..]),
            _ => s,
        };
    }
    format!("{}", n)
}

/// JS ToNumber for strings.
pub fn str_to_num(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return match u64::from_str_radix(h, 16) {
            Ok(v) => v as f64,
            Err(_) => f64::NAN,
        };
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    parse_decimal(t).unwrap_or(f64::NAN)
}

/// A small decimal parser (no_std has no `str::parse::<f64>` we can trust to be
/// tiny on SBF; this one is enough for JSON and querystrings).
pub fn parse_decimal(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut neg = false;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        neg = b[i] == b'-';
        i += 1;
    }
    let mut mant: f64 = 0.0;
    let mut digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        mant = mant * 10.0 + (b[i] - b'0') as f64;
        i += 1;
        digits += 1;
    }
    let mut frac_exp: i32 = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            mant = mant * 10.0 + (b[i] - b'0') as f64;
            frac_exp -= 1;
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return None;
    }
    let mut exp: i32 = 0;
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        let mut eneg = false;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            eneg = b[i] == b'-';
            i += 1;
        }
        let mut e: i32 = 0;
        let mut ed = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            e = e.saturating_mul(10).saturating_add((b[i] - b'0') as i32);
            i += 1;
            ed += 1;
        }
        if ed == 0 {
            return None;
        }
        exp = if eneg { -e } else { e };
    }
    if i != b.len() {
        return None;
    }
    let total = frac_exp + exp;
    let v = if total >= 0 {
        mant * libm::pow(10.0, total as f64)
    } else {
        mant / libm::pow(10.0, (-total) as f64)
    };
    Some(if neg { -v } else { v })
}

impl Val {
    pub fn obj() -> Val {
        Val::Obj(Vec::new())
    }
    pub fn arr() -> Val {
        Val::Arr(Vec::new())
    }
    pub fn str(s: &str) -> Val {
        Val::Str(String::from(s))
    }

    pub fn is_undef(&self) -> bool {
        matches!(self, Val::Undef)
    }
    pub fn is_nullish(&self) -> bool {
        matches!(self, Val::Undef | Val::Null)
    }

    pub fn type_of(&self) -> &'static str {
        match self {
            Val::Undef => "undefined",
            Val::Null => "object",
            Val::Bool(_) => "boolean",
            Val::Num(_) => "number",
            Val::Str(_) => "string",
            Val::Arr(_) | Val::Obj(_) => "object",
        }
    }

    pub fn truthy(&self) -> bool {
        match self {
            Val::Undef | Val::Null => false,
            Val::Bool(b) => *b,
            Val::Num(n) => !(*n == 0.0 || n.is_nan()),
            Val::Str(s) => !s.is_empty(),
            Val::Arr(_) | Val::Obj(_) => true,
        }
    }

    pub fn to_num(&self) -> f64 {
        match self {
            Val::Undef => f64::NAN,
            Val::Null => 0.0,
            Val::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Val::Num(n) => *n,
            Val::Str(s) => str_to_num(s),
            Val::Arr(a) => match a.len() {
                0 => 0.0,
                1 => a[0].to_num(),
                _ => f64::NAN,
            },
            Val::Obj(_) => f64::NAN,
        }
    }

    /// JS ToString (objects stringify like `String(obj)` would; arrays join).
    pub fn to_js_string(&self) -> String {
        match self {
            Val::Undef => String::from("undefined"),
            Val::Null => String::from("null"),
            Val::Bool(b) => String::from(if *b { "true" } else { "false" }),
            Val::Num(n) => num_to_string(*n),
            Val::Str(s) => s.clone(),
            Val::Arr(a) => {
                let mut out = String::new();
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if !v.is_nullish() {
                        out.push_str(&v.to_js_string());
                    }
                }
                out
            }
            Val::Obj(_) => String::from("[object Object]"),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    /// Property read with a string key (`obj.key`, `arr.length`, `str.length`).
    pub fn get_str(&self, key: &str) -> Val {
        match self {
            Val::Obj(kv) => kv
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or(Val::Undef),
            Val::Arr(a) => {
                if key == "length" {
                    return Val::Num(a.len() as f64);
                }
                match parse_index(key) {
                    Some(i) => a.get(i).cloned().unwrap_or(Val::Undef),
                    None => Val::Undef,
                }
            }
            Val::Str(s) => {
                if key == "length" {
                    return Val::Num(s.chars().count() as f64);
                }
                match parse_index(key) {
                    Some(i) => s
                        .chars()
                        .nth(i)
                        .map(|c| Val::Str(c.into()))
                        .unwrap_or(Val::Undef),
                    None => Val::Undef,
                }
            }
            _ => Val::Undef,
        }
    }

    /// Property read with a computed key (`a[b]`).
    pub fn get(&self, key: &Val) -> Val {
        match (self, key) {
            (Val::Arr(a), Val::Num(n)) => {
                if *n >= 0.0 && *n == libm::trunc(*n) {
                    a.get(*n as usize).cloned().unwrap_or(Val::Undef)
                } else {
                    Val::Undef
                }
            }
            (Val::Str(s), Val::Num(n)) => {
                if *n >= 0.0 && *n == libm::trunc(*n) {
                    s.chars()
                        .nth(*n as usize)
                        .map(|c| Val::Str(c.into()))
                        .unwrap_or(Val::Undef)
                } else {
                    Val::Undef
                }
            }
            _ => self.get_str(&key.to_js_string()),
        }
    }

    /// Property write (`obj.k = v`, `arr[i] = v`).
    pub fn set(&mut self, key: &Val, v: Val) {
        match self {
            Val::Obj(kv) => {
                let k = key.to_js_string();
                if let Some(slot) = kv.iter_mut().find(|(kk, _)| *kk == k) {
                    slot.1 = v;
                } else {
                    kv.push((k, v));
                }
            }
            Val::Arr(a) => {
                let idx = match key {
                    Val::Num(n) if *n >= 0.0 && *n == libm::trunc(*n) => Some(*n as usize),
                    Val::Str(s) => parse_index(s),
                    _ => None,
                };
                if let Some(i) = idx {
                    if i >= a.len() {
                        a.resize(i + 1, Val::Undef);
                    }
                    a[i] = v;
                }
            }
            _ => {}
        }
    }

    pub fn set_str(&mut self, key: &str, v: Val) {
        self.set(&Val::str(key), v)
    }

    pub fn delete(&mut self, key: &Val) {
        if let Val::Obj(kv) = self {
            let k = key.to_js_string();
            kv.retain(|(kk, _)| *kk != k);
        }
    }

    pub fn has(&self, key: &Val) -> bool {
        match self {
            Val::Obj(kv) => {
                let k = key.to_js_string();
                kv.iter().any(|(kk, _)| *kk == k)
            }
            Val::Arr(a) => match key {
                Val::Num(n) => *n >= 0.0 && (*n as usize) < a.len(),
                _ => key.to_js_string() == "length",
            },
            _ => false,
        }
    }

    pub fn keys(&self) -> Val {
        match self {
            Val::Obj(kv) => Val::Arr(kv.iter().map(|(k, _)| Val::Str(k.clone())).collect()),
            Val::Arr(a) => Val::Arr((0..a.len()).map(|i| Val::Str(num_to_string(i as f64))).collect()),
            _ => Val::arr(),
        }
    }
    pub fn values(&self) -> Val {
        match self {
            Val::Obj(kv) => Val::Arr(kv.iter().map(|(_, v)| v.clone()).collect()),
            Val::Arr(a) => Val::Arr(a.clone()),
            _ => Val::arr(),
        }
    }
    pub fn entries(&self) -> Val {
        match self {
            Val::Obj(kv) => Val::Arr(
                kv.iter()
                    .map(|(k, v)| Val::Arr(alloc::vec![Val::Str(k.clone()), v.clone()]))
                    .collect(),
            ),
            Val::Arr(a) => Val::Arr(
                a.iter()
                    .enumerate()
                    .map(|(i, v)| Val::Arr(alloc::vec![Val::Num(i as f64), v.clone()]))
                    .collect(),
            ),
            _ => Val::arr(),
        }
    }

    /// Iteration order for `for (const x of v)`.
    pub fn iter_values(&self) -> Vec<Val> {
        match self {
            Val::Arr(a) => a.clone(),
            Val::Str(s) => s.chars().map(|c| Val::Str(c.into())).collect(),
            _ => Vec::new(),
        }
    }

    pub fn push(&mut self, v: Val) -> Val {
        if let Val::Arr(a) = self {
            a.push(v);
            Val::Num(a.len() as f64)
        } else {
            Val::Undef
        }
    }

    // ---- operators ----

    pub fn add(&self, other: &Val) -> Val {
        let lstr = matches!(self, Val::Str(_) | Val::Arr(_) | Val::Obj(_));
        let rstr = matches!(other, Val::Str(_) | Val::Arr(_) | Val::Obj(_));
        if lstr || rstr {
            let mut s = self.to_js_string();
            s.push_str(&other.to_js_string());
            Val::Str(s)
        } else {
            Val::Num(self.to_num() + other.to_num())
        }
    }
    pub fn sub(&self, o: &Val) -> Val {
        Val::Num(self.to_num() - o.to_num())
    }
    pub fn mul(&self, o: &Val) -> Val {
        Val::Num(self.to_num() * o.to_num())
    }
    pub fn div(&self, o: &Val) -> Val {
        Val::Num(self.to_num() / o.to_num())
    }
    pub fn rem(&self, o: &Val) -> Val {
        Val::Num(libm::fmod(self.to_num(), o.to_num()))
    }
    pub fn pow(&self, o: &Val) -> Val {
        Val::Num(libm::pow(self.to_num(), o.to_num()))
    }
    pub fn neg(&self) -> Val {
        Val::Num(-self.to_num())
    }
    pub fn not(&self) -> Val {
        Val::Bool(!self.truthy())
    }
    pub fn bit_and(&self, o: &Val) -> Val {
        Val::Num((to_i32(self.to_num()) & to_i32(o.to_num())) as f64)
    }
    pub fn bit_or(&self, o: &Val) -> Val {
        Val::Num((to_i32(self.to_num()) | to_i32(o.to_num())) as f64)
    }
    pub fn bit_xor(&self, o: &Val) -> Val {
        Val::Num((to_i32(self.to_num()) ^ to_i32(o.to_num())) as f64)
    }
    pub fn shl(&self, o: &Val) -> Val {
        Val::Num(to_i32(self.to_num()).wrapping_shl(to_i32(o.to_num()) as u32 & 31) as f64)
    }
    pub fn shr(&self, o: &Val) -> Val {
        Val::Num((to_i32(self.to_num()) >> (to_i32(o.to_num()) as u32 & 31)) as f64)
    }
    pub fn ushr(&self, o: &Val) -> Val {
        Val::Num(((to_i32(self.to_num()) as u32) >> (to_i32(o.to_num()) as u32 & 31)) as f64)
    }

    pub fn strict_eq(&self, o: &Val) -> bool {
        match (self, o) {
            (Val::Undef, Val::Undef) | (Val::Null, Val::Null) => true,
            (Val::Bool(a), Val::Bool(b)) => a == b,
            (Val::Num(a), Val::Num(b)) => a == b,
            (Val::Str(a), Val::Str(b)) => a == b,
            // Reference equality is not observable in our value model; two
            // structurally equal literals are treated as equal.
            (Val::Arr(a), Val::Arr(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.strict_eq(y)),
            (Val::Obj(a), Val::Obj(b)) => {
                a.len() == b.len()
                    && a.iter().all(|(k, v)| b.iter().any(|(k2, v2)| k == k2 && v.strict_eq(v2)))
            }
            _ => false,
        }
    }

    pub fn loose_eq(&self, o: &Val) -> bool {
        match (self, o) {
            (Val::Undef | Val::Null, Val::Undef | Val::Null) => true,
            (Val::Undef | Val::Null, _) | (_, Val::Undef | Val::Null) => false,
            (Val::Num(_), Val::Str(_)) | (Val::Str(_), Val::Num(_)) => self.to_num() == o.to_num(),
            (Val::Bool(_), _) => Val::Num(self.to_num()).loose_eq(o),
            (_, Val::Bool(_)) => self.loose_eq(&Val::Num(o.to_num())),
            (Val::Arr(_) | Val::Obj(_), Val::Num(_) | Val::Str(_)) => Val::Str(self.to_js_string()).loose_eq(o),
            (Val::Num(_) | Val::Str(_), Val::Arr(_) | Val::Obj(_)) => self.loose_eq(&Val::Str(o.to_js_string())),
            _ => self.strict_eq(o),
        }
    }

    fn compare(&self, o: &Val) -> Option<Ordering> {
        match (self, o) {
            (Val::Str(a), Val::Str(b)) => Some(a.cmp(b)),
            _ => {
                let (a, b) = (self.to_num(), o.to_num());
                a.partial_cmp(&b)
            }
        }
    }
    pub fn lt(&self, o: &Val) -> bool {
        matches!(self.compare(o), Some(Ordering::Less))
    }
    pub fn le(&self, o: &Val) -> bool {
        matches!(self.compare(o), Some(Ordering::Less | Ordering::Equal))
    }
    pub fn gt(&self, o: &Val) -> bool {
        matches!(self.compare(o), Some(Ordering::Greater))
    }
    pub fn ge(&self, o: &Val) -> bool {
        matches!(self.compare(o), Some(Ordering::Greater | Ordering::Equal))
    }

    pub fn r#in(&self, o: &Val) -> bool {
        o.has(self)
    }

    // ---- built-in methods (`recv.name(args)`) ----

    /// Method call on a value. Higher-order methods (map/filter/...) take
    /// their callback through `cb`.
    pub fn call(&mut self, name: &str, args: &[Val], cb: Option<&mut dyn FnMut(&[Val]) -> Val>) -> Result<Val, Val> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Val::Undef);
        match self {
            Val::Str(s) => Ok(str_method(s, name, args)?),
            Val::Num(n) => match name {
                "toFixed" => {
                    let d = if arg(0).is_undef() { 0 } else { arg(0).to_num() as usize };
                    Ok(Val::Str(to_fixed(*n, d)))
                }
                "toString" => Ok(Val::Str(num_to_string(*n))),
                _ => Err(type_error(name)),
            },
            Val::Bool(b) => match name {
                "toString" => Ok(Val::Str(String::from(if *b { "true" } else { "false" }))),
                _ => Err(type_error(name)),
            },
            Val::Arr(a) => {
                match name {
                    "push" => {
                        for v in args {
                            a.push(v.clone());
                        }
                        Ok(Val::Num(a.len() as f64))
                    }
                    "pop" => Ok(a.pop().unwrap_or(Val::Undef)),
                    "shift" => Ok(if a.is_empty() { Val::Undef } else { a.remove(0) }),
                    "unshift" => {
                        for (i, v) in args.iter().enumerate() {
                            a.insert(i, v.clone());
                        }
                        Ok(Val::Num(a.len() as f64))
                    }
                    "join" => {
                        let sep = if arg(0).is_undef() { String::from(",") } else { arg(0).to_js_string() };
                        let parts: Vec<String> = a
                            .iter()
                            .map(|v| if v.is_nullish() { String::new() } else { v.to_js_string() })
                            .collect();
                        Ok(Val::Str(parts.join(&sep)))
                    }
                    "includes" => Ok(Val::Bool(a.iter().any(|v| v.strict_eq(&arg(0))))),
                    "indexOf" => Ok(Val::Num(
                        a.iter().position(|v| v.strict_eq(&arg(0))).map(|i| i as f64).unwrap_or(-1.0),
                    )),
                    "slice" => {
                        let (s, e) = slice_bounds(a.len(), &arg(0), &arg(1));
                        Ok(Val::Arr(a[s..e].to_vec()))
                    }
                    "splice" => {
                        let start = clamp_index(a.len(), &arg(0));
                        let del = if arg(1).is_undef() { a.len() - start } else { (arg(1).to_num().max(0.0) as usize).min(a.len() - start) };
                        let removed: Vec<Val> = a.drain(start..start + del).collect();
                        for (i, v) in args.iter().skip(2).enumerate() {
                            a.insert(start + i, v.clone());
                        }
                        Ok(Val::Arr(removed))
                    }
                    "concat" => {
                        let mut out = a.clone();
                        for v in args {
                            match v {
                                Val::Arr(b) => out.extend(b.iter().cloned()),
                                other => out.push(other.clone()),
                            }
                        }
                        Ok(Val::Arr(out))
                    }
                    "reverse" => {
                        a.reverse();
                        Ok(Val::Arr(a.clone()))
                    }
                    "flat" => {
                        let mut out = Vec::new();
                        for v in a.iter() {
                            match v {
                                Val::Arr(b) => out.extend(b.iter().cloned()),
                                other => out.push(other.clone()),
                            }
                        }
                        Ok(Val::Arr(out))
                    }
                    "toString" => Ok(Val::Str(self.to_js_string())),
                    "map" | "filter" | "find" | "findIndex" | "some" | "every" | "forEach" | "reduce" | "flatMap" | "sort" => {
                        let f = match cb {
                            Some(f) => f,
                            None => return Err(type_error(name)),
                        };
                        let items = a.clone();
                        match name {
                            "map" => {
                                let mut out = Vec::with_capacity(items.len());
                                for (i, v) in items.iter().enumerate() {
                                    out.push(f(&[v.clone(), Val::Num(i as f64)]));
                                }
                                Ok(Val::Arr(out))
                            }
                            "flatMap" => {
                                let mut out = Vec::new();
                                for (i, v) in items.iter().enumerate() {
                                    match f(&[v.clone(), Val::Num(i as f64)]) {
                                        Val::Arr(b) => out.extend(b),
                                        o => out.push(o),
                                    }
                                }
                                Ok(Val::Arr(out))
                            }
                            "filter" => {
                                let mut out = Vec::new();
                                for (i, v) in items.iter().enumerate() {
                                    if f(&[v.clone(), Val::Num(i as f64)]).truthy() {
                                        out.push(v.clone());
                                    }
                                }
                                Ok(Val::Arr(out))
                            }
                            "find" => {
                                for (i, v) in items.iter().enumerate() {
                                    if f(&[v.clone(), Val::Num(i as f64)]).truthy() {
                                        return Ok(v.clone());
                                    }
                                }
                                Ok(Val::Undef)
                            }
                            "findIndex" => {
                                for (i, v) in items.iter().enumerate() {
                                    if f(&[v.clone(), Val::Num(i as f64)]).truthy() {
                                        return Ok(Val::Num(i as f64));
                                    }
                                }
                                Ok(Val::Num(-1.0))
                            }
                            "some" => Ok(Val::Bool(
                                items.iter().enumerate().any(|(i, v)| f(&[v.clone(), Val::Num(i as f64)]).truthy()),
                            )),
                            "every" => Ok(Val::Bool(
                                items.iter().enumerate().all(|(i, v)| f(&[v.clone(), Val::Num(i as f64)]).truthy()),
                            )),
                            "forEach" => {
                                for (i, v) in items.iter().enumerate() {
                                    f(&[v.clone(), Val::Num(i as f64)]);
                                }
                                Ok(Val::Undef)
                            }
                            "reduce" => {
                                let mut it = items.iter().enumerate();
                                let mut acc = if args.is_empty() {
                                    match it.next() {
                                        Some((_, v)) => v.clone(),
                                        None => return Err(type_error("reduce of empty array with no initial value")),
                                    }
                                } else {
                                    arg(0)
                                };
                                for (i, v) in it {
                                    acc = f(&[acc, v.clone(), Val::Num(i as f64)]);
                                }
                                Ok(acc)
                            }
                            "sort" => {
                                let mut items = items;
                                // insertion sort: stable, tiny, no core::slice::sort_by cost
                                for i in 1..items.len() {
                                    let mut j = i;
                                    while j > 0 {
                                        let r = f(&[items[j - 1].clone(), items[j].clone()]).to_num();
                                        if r > 0.0 {
                                            items.swap(j - 1, j);
                                            j -= 1;
                                        } else {
                                            break;
                                        }
                                    }
                                }
                                *a = items.clone();
                                Ok(Val::Arr(items))
                            }
                            _ => unreachable!(),
                        }
                    }
                    _ => Err(type_error(name)),
                }
            }
            Val::Obj(kv) => match name {
                "hasOwnProperty" => Ok(Val::Bool(kv.iter().any(|(k, _)| *k == arg(0).to_js_string()))),
                "toString" => Ok(Val::Str(self.to_js_string())),
                _ => Err(type_error(name)),
            },
            Val::Undef | Val::Null => Err(Val::Str(format!(
                "TypeError: Cannot read properties of {} (reading '{}')",
                self.to_js_string(),
                name
            ))),
        }
    }
}

fn type_error(name: &str) -> Val {
    Val::Str(format!("TypeError: {} is not a function", name))
}

fn to_i32(n: f64) -> i32 {
    if n.is_nan() || n.is_infinite() {
        0
    } else {
        (libm::trunc(n) as i64 as u64 as u32) as i32
    }
}

fn parse_index(s: &str) -> Option<usize> {
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.len() > 1 && s.starts_with('0') {
        return None;
    }
    s.parse::<usize>().ok()
}

fn clamp_index(len: usize, v: &Val) -> usize {
    if v.is_undef() {
        return 0;
    }
    let n = v.to_num();
    if n.is_nan() {
        return 0;
    }
    if n < 0.0 {
        let back = (-n) as usize;
        len.saturating_sub(back)
    } else {
        (n as usize).min(len)
    }
}

fn slice_bounds(len: usize, start: &Val, end: &Val) -> (usize, usize) {
    let s = clamp_index(len, start);
    let e = if end.is_undef() { len } else { clamp_index(len, end) };
    (s, e.max(s))
}

pub fn to_fixed(n: f64, digits: usize) -> String {
    if n.is_nan() {
        return String::from("NaN");
    }
    let m = libm::pow(10.0, digits as f64);
    let r = libm::round(n * m) / m;
    if digits == 0 {
        return format!("{}", r as i128);
    }
    let s = format!("{:.*}", digits, r);
    s
}

fn str_method(s: &mut String, name: &str, args: &[Val]) -> Result<Val, Val> {
    let arg = |i: usize| args.get(i).cloned().unwrap_or(Val::Undef);
    let chars: Vec<char> = s.chars().collect();
    Ok(match name {
        "toUpperCase" => Val::Str(s.to_uppercase()),
        "toLowerCase" => Val::Str(s.to_lowercase()),
        "trim" => Val::Str(String::from(s.trim())),
        "trimStart" => Val::Str(String::from(s.trim_start())),
        "trimEnd" => Val::Str(String::from(s.trim_end())),
        "includes" => Val::Bool(s.contains(arg(0).to_js_string().as_str())),
        "startsWith" => Val::Bool(s.starts_with(arg(0).to_js_string().as_str())),
        "endsWith" => Val::Bool(s.ends_with(arg(0).to_js_string().as_str())),
        "indexOf" => {
            let needle = arg(0).to_js_string();
            Val::Num(match s.find(&needle) {
                Some(b) => s[..b].chars().count() as f64,
                None => -1.0,
            })
        }
        "split" => {
            if arg(0).is_undef() {
                Val::Arr(alloc::vec![Val::Str(s.clone())])
            } else {
                let sep = arg(0).to_js_string();
                if sep.is_empty() {
                    Val::Arr(chars.iter().map(|c| Val::Str((*c).into())).collect())
                } else {
                    Val::Arr(s.split(sep.as_str()).map(|p| Val::Str(String::from(p))).collect())
                }
            }
        }
        "slice" => {
            let (a, b) = slice_bounds(chars.len(), &arg(0), &arg(1));
            Val::Str(chars[a..b].iter().collect())
        }
        "substring" => {
            let a = clamp_index(chars.len(), &arg(0).max0());
            let b = if arg(1).is_undef() { chars.len() } else { clamp_index(chars.len(), &arg(1).max0()) };
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            Val::Str(chars[a..b].iter().collect())
        }
        "substr" => {
            let a = clamp_index(chars.len(), &arg(0));
            let n = if arg(1).is_undef() { chars.len() - a } else { (arg(1).to_num().max(0.0) as usize).min(chars.len() - a) };
            Val::Str(chars[a..a + n].iter().collect())
        }
        "charAt" => {
            let i = if arg(0).is_undef() { 0.0 } else { arg(0).to_num() };
            Val::Str(if i >= 0.0 { chars.get(i as usize).map(|c| String::from(*c)).unwrap_or_default() } else { String::new() })
        }
        "charCodeAt" => {
            let i = if arg(0).is_undef() { 0.0 } else { arg(0).to_num() };
            Val::Num(if i >= 0.0 { chars.get(i as usize).map(|c| *c as u32 as f64).unwrap_or(f64::NAN) } else { f64::NAN })
        }
        "replace" | "replaceAll" => {
            let from = arg(0).to_js_string();
            let to = arg(1).to_js_string();
            if name == "replace" {
                Val::Str(s.replacen(from.as_str(), to.as_str(), 1))
            } else {
                Val::Str(s.replace(from.as_str(), to.as_str()))
            }
        }
        "repeat" => Val::Str(s.repeat(arg(0).to_num().max(0.0) as usize)),
        "padStart" | "padEnd" => {
            let target = arg(0).to_num().max(0.0) as usize;
            let pad = if arg(1).is_undef() { String::from(" ") } else { arg(1).to_js_string() };
            let cur = chars.len();
            if target <= cur || pad.is_empty() {
                Val::Str(s.clone())
            } else {
                let need = target - cur;
                let padc: Vec<char> = pad.chars().collect();
                let filler: String = (0..need).map(|i| padc[i % padc.len()]).collect();
                if name == "padStart" {
                    Val::Str(filler + s)
                } else {
                    Val::Str(s.clone() + &filler)
                }
            }
        }
        "toString" | "valueOf" => Val::Str(s.clone()),
        "concat" => {
            let mut out = s.clone();
            for a in args {
                out.push_str(&a.to_js_string());
            }
            Val::Str(out)
        }
        "at" => {
            let i = arg(0).to_num();
            let idx = if i < 0.0 { chars.len() as f64 + i } else { i };
            if idx >= 0.0 && (idx as usize) < chars.len() { Val::Str(chars[idx as usize].into()) } else { Val::Undef }
        }
        _ => return Err(type_error(name)),
    })
}

impl Val {
    fn max0(&self) -> Val {
        Val::Num(self.to_num().max(0.0))
    }
}

/// `Math.*` for the subset the transmuter accepts.
pub fn math(name: &str, args: &[Val]) -> Result<Val, Val> {
    let a = |i: usize| args.get(i).map(|v| v.to_num()).unwrap_or(f64::NAN);
    Ok(Val::Num(match name {
        "floor" => libm::floor(a(0)),
        "ceil" => libm::ceil(a(0)),
        "round" => libm::floor(a(0) + 0.5),
        "trunc" => libm::trunc(a(0)),
        "abs" => libm::fabs(a(0)),
        "sqrt" => libm::sqrt(a(0)),
        "pow" => libm::pow(a(0), a(1)),
        "sign" => {
            let x = a(0);
            if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { x }
        }
        "log" => libm::log(a(0)),
        "log2" => libm::log2(a(0)),
        "log10" => libm::log10(a(0)),
        "exp" => libm::exp(a(0)),
        "sin" => libm::sin(a(0)),
        "cos" => libm::cos(a(0)),
        "tan" => libm::tan(a(0)),
        "atan2" => libm::atan2(a(0), a(1)),
        "min" => args.iter().map(|v| v.to_num()).fold(f64::INFINITY, f64::min),
        "max" => args.iter().map(|v| v.to_num()).fold(f64::NEG_INFINITY, f64::max),
        "hypot" => libm::sqrt(args.iter().map(|v| v.to_num() * v.to_num()).sum()),
        _ => return Err(type_error(name)),
    }))
}

/// `Number(x)`, `parseInt`, `parseFloat`, `isNaN`, `String(x)`, `Boolean(x)`.
pub fn global_call(name: &str, args: &[Val]) -> Result<Val, Val> {
    let arg = |i: usize| args.get(i).cloned().unwrap_or(Val::Undef);
    Ok(match name {
        "Number" => Val::Num(if args.is_empty() { 0.0 } else { arg(0).to_num() }),
        "String" => Val::Str(if args.is_empty() { String::new() } else { arg(0).to_js_string() }),
        "Boolean" => Val::Bool(arg(0).truthy()),
        "isNaN" => Val::Bool(arg(0).to_num().is_nan()),
        "isFinite" => Val::Bool(arg(0).to_num().is_finite()),
        "parseFloat" => {
            let s = arg(0).to_js_string();
            let t = s.trim();
            // longest numeric prefix
            let mut end = 0;
            let b = t.as_bytes();
            let mut seen_dot = false;
            let mut seen_e = false;
            while end < b.len() {
                let c = b[end];
                let ok = c.is_ascii_digit()
                    || (c == b'.' && !seen_dot && !seen_e)
                    || ((c == b'e' || c == b'E') && !seen_e && end > 0)
                    || ((c == b'+' || c == b'-') && (end == 0 || matches!(b[end - 1], b'e' | b'E')));
                if !ok {
                    break;
                }
                if c == b'.' {
                    seen_dot = true;
                }
                if c == b'e' || c == b'E' {
                    seen_e = true;
                }
                end += 1;
            }
            let mut v = f64::NAN;
            let mut e = end;
            while e > 0 {
                if let Some(x) = parse_decimal(&t[..e]) {
                    v = x;
                    break;
                }
                e -= 1;
            }
            Val::Num(v)
        }
        "parseInt" => {
            let s = arg(0).to_js_string();
            let radix = if arg(1).is_undef() { 10 } else { arg(1).to_num() as u32 };
            let t = s.trim();
            let (neg, t) = match t.strip_prefix('-') {
                Some(r) => (true, r),
                None => (false, t.strip_prefix('+').unwrap_or(t)),
            };
            let (radix, t) = if (radix == 16 || radix == 10 && false) && (t.starts_with("0x") || t.starts_with("0X")) {
                (16, &t[2..])
            } else if radix == 10 && (t.starts_with("0x") || t.starts_with("0X")) {
                (16, &t[2..])
            } else {
                (radix, t)
            };
            let mut v: f64 = 0.0;
            let mut any = false;
            for c in t.chars() {
                match c.to_digit(radix) {
                    Some(d) => {
                        v = v * radix as f64 + d as f64;
                        any = true;
                    }
                    None => break,
                }
            }
            Val::Num(if !any { f64::NAN } else if neg { -v } else { v })
        }
        "encodeURIComponent" => Val::Str(url_encode(&arg(0).to_js_string(), true)),
        "encodeURI" => Val::Str(url_encode(&arg(0).to_js_string(), false)),
        "decodeURIComponent" | "decodeURI" => Val::Str(url_decode(&arg(0).to_js_string())),
        _ => return Err(type_error(name)),
    })
}

pub fn url_encode(s: &str, component: bool) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric()
            || b"-_.!~*'()".contains(&b)
            || (!component && b";,/?:@&=+$#".contains(&b));
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

pub fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            let h = core::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(v) = h {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if b[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(b[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse `a=1&b=x%20y` into an object (last write wins, like `req.query`).
pub fn parse_query(q: &str) -> Val {
    let mut obj = Val::obj();
    for pair in q.trim_start_matches('?').split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => (pair, ""),
        };
        obj.set_str(&url_decode(k), Val::Str(url_decode(v)));
    }
    obj
}
