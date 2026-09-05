//! The Vercel node-bridge contract, as bytes.
//!
//! Vercel's Lambda launcher receives `{"Action":"Invoke","body":"{method,
//! path, headers, encoding, body}"}` and answers `{statusCode, headers,
//! encoding, body}`. `Req`/`Resp` are those two records in a compact
//! little-endian layout that fits a Solana transaction.
//!
//! Instruction data (after the tag byte):
//! ```text
//! u8  route        index into the program's ROUTES table
//! u8  method       0 GET 1 POST 2 PUT 3 DELETE 4 PATCH 5 OPTIONS 6 HEAD
//! u16 path_len     + path bytes   (e.g. "/api/hello/42")
//! u16 query_len    + query bytes  (raw, no leading '?')
//! u16 headers_len  + headers      ("name:value\n" per header, lowercase names)
//! u32 body_len     + body bytes
//! ```
//! Response bytes:
//! ```text
//! u16 status
//! u16 headers_len  + headers ("name:value\n")
//! u32 body_len     + body
//! ```
//! Emitted as `set_return_data` (first 1024 bytes) and as `sol_log_data`
//! chunks `["ZOOR", u16 index, bytes]`; the gateway reassembles the chunks
//! and falls back to return data.
use crate::json;
use crate::val::Val;
use alloc::{string::String, vec::Vec};
use pinocchio::Address;

pub const METHODS: [&str; 7] = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];
pub const LOG_CHUNK: usize = 900;
pub const MAX_RETURN_DATA: usize = 1024;

pub struct Req {
    pub route: u8,
    pub method: u8,
    pub path: String,
    pub query: String,
    pub headers: String,
    pub body: Vec<u8>,
}

impl Req {
    pub fn method_str(&self) -> &'static str {
        METHODS.get(self.method as usize).copied().unwrap_or("GET")
    }
    /// Header lookup by lowercase name.
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        for line in self.headers.split('\n') {
            if let Some(i) = line.find(':') {
                if line[..i] == name {
                    return Some(&line[i + 1..]);
                }
            }
        }
        None
    }
    pub fn headers_val(&self) -> Val {
        let mut o = Val::obj();
        for line in self.headers.split('\n') {
            if let Some(i) = line.find(':') {
                o.set_str(&line[..i], Val::str(&line[i + 1..]));
            }
        }
        o
    }
}

#[derive(Clone)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Default for Resp {
    fn default() -> Self {
        Resp { status: 200, headers: Vec::new(), body: Vec::new() }
    }
}

impl Resp {
    pub fn set_header(&mut self, name: &str, value: &str) {
        let name = name.to_ascii_lowercase();
        if let Some(h) = self.headers.iter_mut().find(|(n, _)| *n == name) {
            h.1 = String::from(value);
        } else {
            self.headers.push((name, String::from(value)));
        }
    }
    pub fn has_header(&self, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        self.headers.iter().any(|(n, _)| *n == name)
    }
    pub fn json(v: &Val, status: u16) -> Resp {
        let mut r = Resp { status, ..Default::default() };
        r.set_header("content-type", "application/json; charset=utf-8");
        r.body = json::stringify(v).into_bytes();
        r
    }
    pub fn json_error(status: u16, msg: &str) -> Resp {
        let mut o = Val::obj();
        o.set_str("error", Val::str(msg));
        Resp::json(&o, status)
    }
}

pub enum WireError {
    Short,
    Utf8,
}

fn take<'a>(b: &'a [u8], i: &mut usize, n: usize) -> Result<&'a [u8], WireError> {
    if *i + n > b.len() {
        return Err(WireError::Short);
    }
    let s = &b[*i..*i + n];
    *i += n;
    Ok(s)
}
fn u16_at(b: &[u8], i: &mut usize) -> Result<usize, WireError> {
    let s = take(b, i, 2)?;
    Ok(u16::from_le_bytes([s[0], s[1]]) as usize)
}
fn u32_at(b: &[u8], i: &mut usize) -> Result<usize, WireError> {
    let s = take(b, i, 4)?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}
fn str_at(b: &[u8], i: &mut usize, n: usize) -> Result<String, WireError> {
    let s = take(b, i, n)?;
    core::str::from_utf8(s).map(String::from).map_err(|_| WireError::Utf8)
}

pub fn parse_req(b: &[u8]) -> Result<Req, WireError> {
    let mut i = 0;
    let route = take(b, &mut i, 1)?[0];
    let method = take(b, &mut i, 1)?[0];
    let n = u16_at(b, &mut i)?;
    let path = str_at(b, &mut i, n)?;
    let n = u16_at(b, &mut i)?;
    let query = str_at(b, &mut i, n)?;
    let n = u16_at(b, &mut i)?;
    let headers = str_at(b, &mut i, n)?;
    let n = u32_at(b, &mut i)?;
    let body = take(b, &mut i, n)?.to_vec();
    Ok(Req { route, method, path, query, headers, body })
}

pub fn encode_req(r: &Req) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(r.route);
    out.push(r.method);
    out.extend_from_slice(&(r.path.len() as u16).to_le_bytes());
    out.extend_from_slice(r.path.as_bytes());
    out.extend_from_slice(&(r.query.len() as u16).to_le_bytes());
    out.extend_from_slice(r.query.as_bytes());
    out.extend_from_slice(&(r.headers.len() as u16).to_le_bytes());
    out.extend_from_slice(r.headers.as_bytes());
    out.extend_from_slice(&(r.body.len() as u32).to_le_bytes());
    out.extend_from_slice(&r.body);
    out
}

pub fn encode_resp(r: &Resp) -> Vec<u8> {
    let mut hdr = String::new();
    for (k, v) in r.headers.iter() {
        hdr.push_str(k);
        hdr.push(':');
        hdr.push_str(v);
        hdr.push('\n');
    }
    let mut out = Vec::with_capacity(8 + hdr.len() + r.body.len());
    out.extend_from_slice(&r.status.to_le_bytes());
    out.extend_from_slice(&(hdr.len() as u16).to_le_bytes());
    out.extend_from_slice(hdr.as_bytes());
    out.extend_from_slice(&(r.body.len() as u32).to_le_bytes());
    out.extend_from_slice(&r.body);
    out
}

pub fn decode_resp(b: &[u8]) -> Result<Resp, WireError> {
    let mut i = 0;
    let status = u16_at(b, &mut i)? as u16;
    let n = u16_at(b, &mut i)?;
    let hdr = str_at(b, &mut i, n)?;
    let n = u32_at(b, &mut i)?;
    let body = take(b, &mut i, n)?.to_vec();
    let mut headers = Vec::new();
    for line in hdr.split('\n') {
        if let Some(c) = line.find(':') {
            headers.push((String::from(&line[..c]), String::from(&line[c + 1..])));
        }
    }
    Ok(Resp { status, headers, body })
}

/// Publish the response: return data (truncated at 1024) + log chunks.
pub fn emit(bytes: &[u8]) {
    let head = &bytes[..bytes.len().min(MAX_RETURN_DATA)];
    pinocchio::cpi::set_return_data(head);
    let mut idx: u16 = 0;
    let mut off = 0;
    while off < bytes.len() {
        let end = (off + LOG_CHUNK).min(bytes.len());
        log_data(&[b"ZOOR", &idx.to_le_bytes(), &bytes[off..end]]);
        off = end;
        idx += 1;
    }
    if bytes.is_empty() {
        log_data(&[b"ZOOR", &0u16.to_le_bytes(), &[]]);
    }
}

pub fn log_kv_missing(pda: &Address) {
    log_data(&[b"ZOOK", pda.as_ref()]);
}

#[cfg(any(target_os = "solana", target_arch = "bpf"))]
pub fn log_data(parts: &[&[u8]]) {
    unsafe {
        pinocchio::syscalls::sol_log_data(parts.as_ptr() as *const u8, parts.len() as u64);
    }
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
pub fn log_data(parts: &[&[u8]]) {
    core::hint::black_box(parts);
}

#[cfg(any(target_os = "solana", target_arch = "bpf"))]
pub fn log_str(s: &str) {
    unsafe { pinocchio::syscalls::sol_log_(s.as_ptr(), s.len() as u64) }
}
#[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
pub fn log_str(s: &str) {
    core::hint::black_box(s);
}
