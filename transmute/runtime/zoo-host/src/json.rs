//! JSON <-> `Val`. Hand-rolled: serde would triple the program size.
use crate::val::{num_to_string, parse_decimal, Val};
use alloc::{string::String, vec::Vec};

pub fn stringify(v: &Val) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Val, out: &mut String) {
    match v {
        // JSON.stringify(undefined) is undefined; inside containers we map to null.
        Val::Undef | Val::Null => out.push_str("null"),
        Val::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Val::Num(n) => {
            if n.is_finite() {
                out.push_str(&num_to_string(*n))
            } else {
                out.push_str("null")
            }
        }
        Val::Str(s) => write_str(s, out),
        Val::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Val::Obj(kv) => {
            out.push('{');
            let mut first = true;
            for (k, x) in kv.iter() {
                if x.is_undef() {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_str(k, out);
                out.push(':');
                write(x, out);
            }
            out.push('}');
        }
    }
}

pub fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str("\\u00");
                let b = c as u32;
                out.push(hex((b >> 4) as u8));
                out.push(hex((b & 0xf) as u8));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn hex(n: u8) -> char {
    b"0123456789abcdef"[n as usize] as char
}

pub fn parse(s: &str) -> Result<Val, Val> {
    let mut p = Parser { b: s.as_bytes(), i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(p.err("Unexpected non-whitespace character after JSON"));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn err(&self, msg: &str) -> Val {
        Val::Str(alloc::format!("SyntaxError: {} at position {}", msg, self.i))
    }
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn value(&mut self) -> Result<Val, Val> {
        match self.peek() {
            None => Err(self.err("Unexpected end of JSON input")),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Val::Str(self.string()?)),
            Some(b't') => self.lit("true", Val::Bool(true)),
            Some(b'f') => self.lit("false", Val::Bool(false)),
            Some(b'n') => self.lit("null", Val::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.number(),
            Some(_) => Err(self.err("Unexpected token")),
        }
    }
    fn lit(&mut self, word: &str, v: Val) -> Result<Val, Val> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(self.err("Unexpected token"))
        }
    }
    fn number(&mut self) -> Result<Val, Val> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-') {
                self.i += 1;
            } else {
                break;
            }
        }
        let text = core::str::from_utf8(&self.b[start..self.i]).map_err(|_| self.err("bad number"))?;
        parse_decimal(text).map(Val::Num).ok_or_else(|| self.err("bad number"))
    }
    fn string(&mut self) -> Result<String, Val> {
        self.i += 1; // opening quote
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = match self.peek() {
                None => return Err(self.err("Unterminated string")),
                Some(c) => c,
            };
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = self.peek().ok_or_else(|| self.err("Unterminated string"))?;
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) && self.b[self.i..].starts_with(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                }
                            }
                            let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => return Err(self.err("Bad escaped character")),
                    }
                }
                _ => out.push(c),
            }
        }
        String::from_utf8(out).map_err(|_| self.err("Bad UTF-8 in string"))
    }
    fn hex4(&mut self) -> Result<u32, Val> {
        if self.i + 4 > self.b.len() {
            return Err(self.err("Bad unicode escape"));
        }
        let s = core::str::from_utf8(&self.b[self.i..self.i + 4]).map_err(|_| self.err("Bad unicode escape"))?;
        let v = u32::from_str_radix(s, 16).map_err(|_| self.err("Bad unicode escape"))?;
        self.i += 4;
        Ok(v)
    }
    fn array(&mut self) -> Result<Val, Val> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Val::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value()?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Val::Arr(items));
                }
                _ => return Err(self.err("Expected ',' or ']'")),
            }
        }
    }
    fn object(&mut self) -> Result<Val, Val> {
        self.i += 1;
        let mut kv: Vec<(String, Val)> = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Val::Obj(kv));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.err("Expected property name"));
            }
            let k = self.string()?;
            self.ws();
            if self.peek() != Some(b':') {
                return Err(self.err("Expected ':'"));
            }
            self.i += 1;
            self.ws();
            let v = self.value()?;
            if let Some(slot) = kv.iter_mut().find(|(kk, _)| *kk == k) {
                slot.1 = v;
            } else {
                kv.push((k, v));
            }
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Val::Obj(kv));
                }
                _ => return Err(self.err("Expected ',' or '}'")),
            }
        }
    }
}
