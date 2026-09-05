//! Host-side VM harness: `vmrun <module.bin> <route> <method> <path> [query] [body] [headers]`
//! prints the bridge response as JSON. No chain: KV calls report as missing.
use std::io::Read;
use zoo_host::{vm, wire::Req, Ctx};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut code = Vec::new();
    std::fs::File::open(&args[1]).unwrap().read_to_end(&mut code).unwrap();
    let route: usize = args[2].parse().unwrap();
    let method = zoo_host::wire::METHODS.iter().position(|m| *m == args[3]).unwrap_or(0) as u8;
    let req = Req {
        route: route as u8,
        method,
        path: args.get(4).cloned().unwrap_or_else(|| "/".into()),
        query: args.get(5).cloned().unwrap_or_default(),
        headers: args.get(7).cloned().unwrap_or_default().replace("\\n", "\n"),
        body: args.get(6).cloned().unwrap_or_default().into_bytes(),
    };
    let program_id = pinocchio::Address::new_from_array([7u8; 32]);
    let mut accounts: [pinocchio::AccountView; 0] = [];
    let mut cx = Ctx::new(&program_id, &mut accounts, req, &[]);
    let out = vm::invoke_module(&mut cx, &code, route);
    let status_body = match out {
        Ok(()) if cx.sent => (cx.res.status, String::from_utf8_lossy(&cx.res.body).into_owned(), cx.res.headers.clone()),
        Ok(()) => (504, "no response".into(), vec![]),
        Err(e) => {
            let r = vm::error_resp(&e);
            (r.status, String::from_utf8_lossy(&r.body).into_owned(), r.headers.clone())
        }
    };
    let hdrs: Vec<String> = status_body.2.iter().map(|(k, v)| format!("\"{}\":\"{}\"", k, v.replace('"', "\\\""))).collect();
    println!("{{\"status\":{},\"headers\":{{{}}},\"body\":{}}}", status_body.0, hdrs.join(","), serde_free(&status_body.1));
}

fn serde_free(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"), _ => o.push(c) }
    }
    o.push('"');
    o
}
