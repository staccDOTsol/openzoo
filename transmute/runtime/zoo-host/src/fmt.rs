//! Number and hex formatting without `core::fmt`: the float/integer printers
//! behind `format!` cost ~50 KB of program (flt2dec dragon/grisu + Formatter),
//! which at Solana rent rates is a third of a SOL per site. These are the
//! handful of shapes the runtime actually needs.
use alloc::string::String;

pub fn push_u64(out: &mut String, mut n: u64) {
    if n == 0 {
        out.push('0');
        return;
    }
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    for &b in &buf[i..] {
        out.push(b as char);
    }
}

pub fn push_i64(out: &mut String, n: i64) {
    if n < 0 {
        out.push('-');
        push_u64(out, n.unsigned_abs());
    } else {
        push_u64(out, n as u64);
    }
}

/// Zero-padded decimal (for dates: `2026`, `09`, `007`).
pub fn push_padded(out: &mut String, n: u64, width: usize) {
    let mut tmp = String::new();
    push_u64(&mut tmp, n);
    for _ in tmp.len()..width {
        out.push('0');
    }
    out.push_str(&tmp);
}

pub fn push_hex2(out: &mut String, b: u8) {
    const H: &[u8; 16] = b"0123456789ABCDEF";
    out.push(H[(b >> 4) as usize] as char);
    out.push(H[(b & 15) as usize] as char);
}

pub fn u64_string(n: u64) -> String {
    let mut s = String::new();
    push_u64(&mut s, n);
    s
}

/// 10^k for small k without `libm::pow`.
pub fn pow10(k: u32) -> f64 {
    let mut v = 1.0;
    for _ in 0..k {
        v *= 10.0;
    }
    v
}

/// JS `Number.prototype.toString()` for the common cases, hand-rolled:
/// integers exactly (|n| < 1e21), otherwise up to 15 significant digits with
/// trailing zeros trimmed (`0.1 + 0.2` prints `0.30000000000000004` in JS and
/// `0.3` here — the one visible difference), exponent form outside
/// [1e-6, 1e21) like JS.
pub fn push_f64(out: &mut String, n: f64) {
    if n.is_nan() {
        out.push_str("NaN");
        return;
    }
    if n.is_infinite() {
        out.push_str(if n > 0.0 { "Infinity" } else { "-Infinity" });
        return;
    }
    if n == 0.0 {
        out.push('0');
        return;
    }
    let neg = n < 0.0;
    let a = if neg { -n } else { n };
    if neg {
        out.push('-');
    }
    if a == libm::trunc(a) && a < 9.0e18 {
        push_u64(out, a as u64);
        return;
    }
    // Scientific decomposition: a = m × 10^e with 1 <= m < 10.
    let mut e: i32 = 0;
    let mut m = a;
    while m >= 10.0 {
        m /= 10.0;
        e += 1;
    }
    while m < 1.0 {
        m *= 10.0;
        e -= 1;
    }
    // 15 significant digits, rounded.
    let mut digits = [0u8; 17];
    let mut nd = 0;
    let mut scaled = m * 1e14; // 15 digits before the point
    scaled = libm::round(scaled);
    if scaled >= 1e15 {
        scaled /= 10.0;
        e += 1;
    }
    let mut v = scaled as u64;
    let mut tmp = [0u8; 20];
    let mut i = tmp.len();
    while v > 0 {
        i -= 1;
        tmp[i] = (v % 10) as u8;
        v /= 10;
    }
    for &d in &tmp[i..] {
        digits[nd] = d;
        nd += 1;
    }
    while nd > 1 && digits[nd - 1] == 0 {
        nd -= 1;
    }
    if !(-7..21).contains(&e) {
        out.push((b'0' + digits[0]) as char);
        if nd > 1 {
            out.push('.');
            for &d in &digits[1..nd] {
                out.push((b'0' + d) as char);
            }
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        push_u64(out, e.unsigned_abs() as u64);
        return;
    }
    if e < 0 {
        out.push_str("0.");
        for _ in 0..(-e - 1) {
            out.push('0');
        }
        for &d in &digits[..nd] {
            out.push((b'0' + d) as char);
        }
        return;
    }
    let int_len = (e + 1) as usize;
    for k in 0..int_len {
        out.push((b'0' + if k < nd { digits[k] } else { 0 }) as char);
    }
    if nd > int_len {
        out.push('.');
        for &d in &digits[int_len..nd] {
            out.push((b'0' + d) as char);
        }
    }
}

/// `toFixed(digits)`.
pub fn to_fixed(n: f64, digits: usize) -> String {
    let mut out = String::new();
    if n.is_nan() {
        out.push_str("NaN");
        return out;
    }
    let neg = n < 0.0;
    let a = if neg { -n } else { n };
    let m = pow10(digits as u32);
    let scaled = libm::round(a * m) as u64;
    let int = scaled / (m as u64);
    let frac = scaled % (m as u64);
    if neg && scaled != 0 {
        out.push('-');
    }
    push_u64(&mut out, int);
    if digits > 0 {
        out.push('.');
        let mut f = String::new();
        push_u64(&mut f, frac);
        for _ in f.len()..digits {
            out.push('0');
        }
        out.push_str(&f);
    }
    out
}
