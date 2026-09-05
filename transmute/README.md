# openzoo-transmute

Transmute a Vercel-shaped app — Next.js `pages/api`, app-router `route.ts`, or
a Vite repo with `api/*.js` — into **(a)** a Rust [Pinocchio](https://github.com/anza-xyz/pinocchio)
Solana program that hosts the `/api/*` Lambdas as instruction routes and
**(b)** the static build stored in program-derived accounts; deploy it to
Solana; serve it through a local gateway that speaks the same routes Vercel
would.

```
vercel build  ─►  .vercel/output/{config.json, static/, functions/*.func}
                                    │
openzoo build ─►  .zoo-out/.zoo/{crate/ (Rust), manifest.json, deploy/<site>.so, static-plan.json}
openzoo deploy ─► program id + one asset account per file + /.zoo/manifest.json
openzoo serve ─►  http://127.0.0.1:4402/  (GET = free simulation, POST = signed transaction)
```

The whole reverse-engineering — what `vercel build` emits, what the Lambda
receives from `@vercel/node-bridge`, what Fluid Compute changes, the term-by-term
mapping, the limits, the cost model and the security notes — is in
[`docs/VERCEL_TO_SOLANA.md`](docs/VERCEL_TO_SOLANA.md). The patch that mounts
these commands in `npx openzoo` is [`docs/OPENZOO_CLI_PATCH.md`](docs/OPENZOO_CLI_PATCH.md).

## How it works

* **The Lambda contract becomes instruction data.** Vercel's bridge hands a
  function `{method, path, headers, body}` and expects `{statusCode, headers,
  body}`. `lib/wire.js` and `runtime/zoo-host/src/wire.rs` are that pair as
  bytes: `[tag][route][method][path][query][headers][body]` in, `[status][headers][body]`
  out via `set_return_data` plus `sol_log_data` chunks.
* **Each handler becomes a Rust route.** The compiler (`lib/compile/`) lowers
  the JS subset it accepts onto `zoo_host::{Ctx, Val}` — a JS-semantics dynamic
  value with `req.query`/`req.body`/`res.json`/`Response.json`/`kv.*`/`process.env`
  implemented in `runtime/zoo-host/src/{ctx,val,json,kv}.rs`. Anything outside
  the subset (network, fs, timers, regex, classes…) is reported with `file:line`
  and the rest of the app still builds.
* **`static/` becomes asset PDAs.** One rent-exempt account per file, written in
  900-byte chunks, writes gated by the program's upgrade authority
  (`runtime/zoo-host/src/assets.rs`). `@vercel/kv` becomes KV PDAs the program
  discovers by dry run.
* **Reads are free, writes are transactions.** `GET/HEAD/OPTIONS` run as
  `simulateTransaction` (no signature, no fee); everything else is a signed
  transaction paid by the gateway wallet. Without a wallet the gateway answers
  `402` — the seam where openzoo's x402 flow plugs in.

## Install

```sh
# from this repository — the package is not on npm yet (`npm view openzoo-transmute` → 404)
cd openzoo-transmute && npm install --no-audit --no-fund
node bin/openzoo-transmute.js help        # or: npm link && openzoo-transmute help

# once published: npx openzoo-transmute help
# through the openzoo CLI once docs/OPENZOO_CLI_PATCH.md is applied:
npx openzoo build | deploy | serve | inspect
```

Until it is published, read `npx openzoo-transmute` in the examples below as
`node <repo>/openzoo-transmute/bin/openzoo-transmute.js` (or the `npm link`ed
`openzoo-transmute`).

Requirements: Node ≥ 18, and for `build`/`deploy` the Solana toolchain
(`cargo build-sbf`): `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`.
`build --skip-cargo` works without it (you get the crate and the cost sheet, no `.so`).

## Quickstart (shared runtime — the default)

A site does not need its own program. The `zoo-vm` runtime
(`runtime/zoo-vm`, prebuilt at `prebuilt/zoo_vm.v0.so`) is deployed once per
cluster; every site is then just data accounts under it — a 66-byte site
account, its bytecode module (`/.zoo/code.bin`, ~1–2 KB for a handful of
routes), its static files and its manifest. Rent for a small site is
**≈0.03–0.1 SOL** instead of ≈1 SOL+ for a dedicated program.

```sh
cd my-next-app                      # or a Vite repo with api/*.js, or a .vercel/output
npx openzoo-transmute inspect       # the app in Vercel terms + eligibility report
npx openzoo-transmute build         # → .zoo-out/.zoo/{code.bin,manifest.json,…}; no cargo needed
npx openzoo-transmute deploy --cluster mainnet --runtime <zoo-vm id> --yes
npx openzoo-transmute serve         # site id + runtime read from .zoo/deploy.json
open http://127.0.0.1:4402/         # explorer at /.zoo/, manifest at /.zoo/manifest.json
```

The site id is the public key of `.zoo/site-keypair.json` (looks like a
program id, costs nothing; keep it — redeploys update the same site). The hub
serves it at `https://sites.openzoo.fun/s/<siteId>` once its
`OPENZOO_VM_PROGRAM` points at the same runtime.

Deploying the runtime itself (once, ≈2.2 SOL on mainnet for the 313 KB .so,
upgradeable by the deployer's key):

```sh
npx openzoo-transmute runtime deploy --cluster mainnet --yes     # keypair → ./zoo-vm-keypair.json
export OPENZOO_VM_PROGRAM=<printed id>
```

`--target program` keeps the original path: one Pinocchio program per site,
compiled from the generated crate with `cargo build-sbf`.

## Quickstart (dedicated program)

```sh
npx openzoo-transmute build --target program   # → .zoo-out/.zoo/{crate,manifest.json,deploy/*.so}
npx openzoo-transmute deploy --cluster mainnet --yes
npx openzoo-transmute serve <programId> --cluster mainnet
```

`inspect` prints one line per function with its route, style, runtime,
`maxDuration`, `memory` and methods, marks each `✓`/`✗` and says why:

```
functions (2):
  ✓ /api/hello                       pages        nodejs20.x  10s   1024MB  any
      pages/api/hello.js  env=GREETING
  ✓ /api/counter                     app          nodejs20.x  10s   1024MB  POST
      app/api/counter/route.js  env=GREETING
```

`deploy` prints the rent sheet before spending anything and refuses mainnet
without `--yes` (this one was measured on a local validator for the two-route
sample in [The generated crate](#the-generated-crate), `.so` built with `--arch v3`):

```
  item                                bytes       SOL
  program account                        36    0.0011
  program data (2×.so = 416,672 B)  416,717    2.9012
  /app.js                                52    0.0013
  /index.html                            44    0.0012
  /.zoo/manifest.json (manifest)        939    0.0074
  rent total                                   2.9123
  + tx fees (approx.)                          0.0012
  TOTAL                                        2.9135
  (rent per http://127.0.0.1:8899)
```

Then `serve` maps HTTP onto the program:

```
GET /                        → 200 text/html          (asset PDA, etag, 304 on If-None-Match)
GET /api/hello?name=zoo&n=21 → 200 {"hello":"zoo","n":42,"greeting":"hi"}   x-zoo-simulated: true, x-zoo-cu: 11067
POST /api/counter            → 200 {"hits":1}         x-zoo-signature: <tx>, x-zoo-simulated: false, x-zoo-cu: 10634
POST /api/counter            → 402 payment required   (gateway started without a keypair)
```

## CLI reference

| command | what it does |
|---|---|
| `build [dir] [--target shared\|program] [--runtime <id>] [--out .zoo-out] [--name <crate>] [--arch v0\|v3] [--cluster <c>] [--skip-cargo] [--json]` | `--target shared` (default): transmute to a `ZOOB` bytecode module at `<out>/.zoo/code.bin` for the shared runtime, no cargo, site-sized cost sheet. `--target program`: read the app (`lib/vercel.js`), transmute (`lib/compile/`), write `<out>/.zoo/{crate/, manifest.json, report.json, static-plan.json, build.json}`, run `cargo build-sbf --arch <arch>` → `.zoo/deploy/<name>.so`, print the cost sheet (`--cluster` only chooses the RPC whose rent parameters price it, default `localnet`; unreachable → the 6.96 SOL/MB rule). Default arch is `v0` (mainnet); `deploy` re-detects the cluster's SBPF version and rebuilds if needed. Exit code 2 when nothing was eligible |
| `deploy [dir\|outDir] [--cluster mainnet\|devnet\|testnet\|localnet\|<url>] [--keypair <path>] [--yes] [--runtime <id>] [--program <id>] [--concurrency 4] [--skip-assets] [--force] [--json]` | shared build: create the site account under `--runtime` (or `OPENZOO_VM_PROGRAM`), upload `code.bin`, assets and manifest as PDAs namespaced by the site id (keypair at `.zoo/site-keypair.json`). Program build: deploy or upgrade the program (keypair kept at `.zoo/program-keypair.json`, so redeploys upgrade in place), upload every static file (unchanged ones skipped by comparing bytes on chain), write `/.zoo/manifest.json`, record `.zoo/deploy.json` |
| `serve [siteId\|programId] [--runtime <id>] [--cluster <c>] [--port 4402] [--host 127.0.0.1] [--keypair <path>\|--no-keypair] [--quiet]` | the local gateway; with `--runtime` the positional is a site id on the shared runtime. It defaults to the `.zoo/deploy.json` under the current directory (or its `.zoo-out/`). Reads are simulated, writes are signed by the wallet; without a wallet (or with `--no-keypair`) writes answer 402. Without `--cluster`/`OPENZOO_CLUSTER` this command assumes `localnet`, unlike the others |
| `inspect [dir] [--json]` | the Vercel model (functions, static files, routes, crons) plus the eligibility report |
| `status <siteId\|programId> [--runtime <id>] [--cluster <c>] [--json]` | program account, authority, `maxDataLen`, deploy slot, and the on-chain manifest; with `--runtime`, the site account and its manifest |
| `runtime deploy [--cluster <c>] [--keypair <path>] [--yes] [--program-keypair zoo-vm-keypair.json] [--so <path>]` | deploy (or upgrade in place) the shared `zoo-vm` runtime: `prebuilt/zoo_vm.<arch>.so`, or built from `runtime/zoo-vm` when no prebuilt matches the cluster's SBPF version |
| `runtime status <id> [--cluster <c>]` | the runtime program's account |
| `help`, `--version` | |

Environment: `OPENZOO_VM_PROGRAM` (shared runtime id; default for `--runtime`), `OPENZOO_TARGET` (`shared`/`program`), `OPENZOO_CLUSTER` (default `mainnet` for `deploy`/`status`, `localnet` for `serve`), `OPENZOO_RPC` (mainnet RPC
URL), `OPENZOO_KEYPAIR` / `OPENZOO_WALLET` (signer path), `OPENZOO_DEBUG=1`
(stack traces). Signer discovery order (`lib/wallet.js`): `--keypair` →
`OPENZOO_KEYPAIR` → `OPENZOO_WALLET` or `~/.openzoo/wallet.json` (the openzoo
burner, `{solana:[64 bytes]}` or a bare `solana-keygen` array) → `~/.config/solana/id.json`.

Gateway responses carry `x-zoo-program`, `x-zoo-route`, `x-zoo-simulated`,
`x-zoo-cu`, `x-zoo-signature` (writes) and `x-zoo-asset` (static); route params
reach the handler as `x-zoo-param-<name>` headers. `413` above 900 body bytes,
`405` when an app-router file does not export the method, `502` with the last
program log lines when the instruction fails, `404` JSON (or the app's
`handle: error` route) otherwise.

## The generated crate

`build` writes a crate that depends on the runtime by path. For this two-route
sample —

```js
// pages/api/hello.js
export default function handler(req, res) {
  res.status(200).json({ hello: req.query.name || 'world', n: Number(req.query.n) * 2, greeting: process.env.GREETING })
}
// app/api/counter/route.js
import { kv } from '@vercel/kv'
export async function POST() { const n = await kv.incr('hits'); return Response.json({ hits: n }) }
```

— with `GREETING=hi` in `.env.production`, the compiler (`lib/compile/index.js`,
`transmute()`) emits exactly this; only the ~240-line prelude of helper
functions between the entrypoint and the routes is elided:

```toml
# .zoo-out/.zoo/crate/Cargo.toml   (crate name = the app directory, underscored)
[package]
name = "my_site"
version = "0.1.0"
edition = "2021"
description = "Generated by openzoo-transmute: Vercel Lambdas re-hosted as a Solana program"
publish = false

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
pinocchio = "0.11.2"
libm = "0.2"
zoo-host = { path = "<openzoo-transmute>/runtime/zoo-host" }

[profile.release]
overflow-checks = false
lto = "fat"
codegen-units = 1
opt-level = 3
```

```rust
// .zoo-out/.zoo/crate/src/lib.rs
//! Generated by openzoo-transmute — do not edit.
//! nextjs (nextjs) — 2 route(s), 2 static file(s)
//! route 0: /api/hello ← api/hello
//! route 1: /api/counter [POST] ← api/counter
#![no_std]
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
const ENV: &[(&str, &str)] = &[("GREETING", "hi")];
/// Route table: instruction byte 1 indexes it.
const ROUTES: &[Route] = &[route_0, route_1];

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    zoo_host::dispatch(program_id, accounts, data, ROUTES, ENV)
}

// … prelude: __zoo_query (req.query + route params), __zoo_resp / __zoo_send (Response objects),
//    __zoo_cookies, __zoo_num, __zoo_set_headers, … …

// ---- route 0: api/hello (pages/api/hello.js)
const PARAMS_0: &[(&str, bool)] = &[];
fn route_0(cx: &mut Ctx) -> Result<(), Val> {
    let _ = { let __a1 = Val::Num(200.0); cx.res_status(&__a1); Val::Undef };
    let _ = { let __a2 = { let mut __o3 = Val::obj(); __o3.set_str("hello", { let __x4 = (__zoo_query(cx, PARAMS_0)).get_str("name"); if !__x4.truthy() { Val::str("world") } else { __x4 } }); __o3.set_str("n", ({ let __a: Vec<Val> = alloc::vec![(__zoo_query(cx, PARAMS_0)).get_str("n")]; zv::global_call("Number", &__a)? }).mul(&(Val::Num(2.0)))); __o3.set_str("greeting", { let __a5 = Val::str("GREETING"); cx.env(&__a5) }); __o3 }; cx.res_json(&__a2); Val::Undef };
    Ok(())
}

// ---- route 1: api/counter (app/api/counter/route.js)
const PARAMS_1: &[(&str, bool)] = &[];
fn route_1(cx: &mut Ctx) -> Result<(), Val> {
    let __m = cx.req_method();
    match __m.as_str() {
        Some("POST") => route_1_post(cx),
        Some("OPTIONS") => { cx.res_status(&Val::Num(204.0)); cx.res_header(&Val::str("allow"), &Val::str("POST, OPTIONS")); cx.res_end(&Val::Undef); Ok(()) }
        _ => { cx.res_status(&Val::Num(405.0)); cx.res_header(&Val::str("allow"), &Val::str("POST, OPTIONS")); cx.res_end(&Val::Undef); Ok(()) }
    }
}
fn route_1_post(cx: &mut Ctx) -> Result<(), Val> {
    let mut v_n: Val = { let __a6 = Val::str("hits"); let __a7 = Val::Num(1.0); cx.kv_incrby(&__a6, &__a7)? };
    { let __rv = { let __b = { let mut __o8 = Val::obj(); __o8.set_str("hits", v_n.clone()); __o8 }; let __i = Val::Undef; __zoo_resp("json", __b, __i) }; __zoo_send(cx, &__rv)?; }
    return Ok(());
    Ok(())
}
```

`Route = fn(&mut Ctx) -> Result<(), Val>`; `Err(v)` is a thrown JS value and
answers 500 like a crashed Lambda; returning without responding answers 504 like
a Lambda that never ended its response. The `?` after `kv_incrby` is the KV
account-discovery path: a missing account is logged as `ZOOK` and the gateway
retries with it. Built with `--arch v3` this crate is a 208,336-byte `.so`
(a 416,717-byte program data account, 2.90 SOL of rent); on a local validator
`GET /api/hello?name=zoo&n=21` costs 11,067 CU and `POST /api/counter`
10,634 CU — nowhere near the 400 k limit.

## Tests

```sh
cd openzoo-transmute
npm install --no-audit --no-fund
npm test                                   # node --test test/*.test.js
```

The unit tests need no chain. The end-to-end test in `test/gateway.test.js`
deploys a pre-built site program and drives the gateway against a **local
validator**; it skips itself with a reason when either is missing:

```sh
# 1. toolchain (once)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 2. a validator with a funded wallet (keep it running in another shell)
solana-test-validator --reset
solana airdrop 100 --url http://127.0.0.1:8899   # ~/.config/solana/id.json

# 3. a site program with route 0 = /api/hello (pages style) and route 1 =
#    /api/counter (POST, kv key "hits") — e.g. the two-route sample below
#    (test validator = SBPF v3; mainnet = v0):
openzoo-transmute build <sample> --arch v3       # → <sample>/.zoo-out/.zoo/deploy/<name>.so
#    then point the SAMPLE_SO constant in test/gateway.test.js at that .so
#    (it is a fixed path today; no sample crate ships with the package yet)

# 4. run
OPENZOO_TEST_RPC=http://127.0.0.1:8899 npm test
```

`test/gateway.test.js` looks for the `.so` at `SAMPLE_SO` and a validator at
`OPENZOO_TEST_RPC` (default `http://127.0.0.1:8899`); `test/build.test.js`
probes `localnet` for real rent numbers and falls back to the 6.96 SOL/MB rule.
The runtime crate also builds on the host (`cd runtime/zoo-host && cargo build`;
its `Cargo.toml` pulls the sha2/curve25519 fallbacks for non-SBF targets), and
for the chain: `cargo build-sbf --arch v3` (test validator) or `--arch v0` (mainnet).

## Repository layout

```
bin/openzoo-transmute.js     the executable (→ lib/cli.js run())
lib/cli.js                   build · deploy · serve · inspect · status
lib/vercel.js                the Vercel deployment model (Build Output API v3 reader / synthesizer)
lib/eligibility.js           what can run on chain, with reasons
lib/compile/                 JS → Rust: parse.js (acorn + TS stripping) → ir.js (lowering) → rust.js (printer, crate skeleton, prelude)
lib/build.js                 crate + manifest + cargo build-sbf + cost sheet
lib/deploy.js                deploy / upgrade + assets + manifest
lib/gateway.js               the local HTTP front (routes, static, 402/413 seams, explorer)
lib/solana.js                loader (deploy/upgrade in pure JS), assets, KV, invoke + discovery
lib/wire.js                  the bridge contract as bytes, PDAs
lib/wallet.js                signer discovery, cluster URLs
runtime/zoo-host/            the no_std pinocchio runtime the generated crate links
docs/VERCEL_TO_SOLANA.md     the reverse-engineering document
docs/OPENZOO_CLI_PATCH.md    mounting build/deploy/serve in npx openzoo
```

## Limits at a glance

| | |
|---|---|
| request body | 900 B (one transaction is 1232 B) |
| response | ≤ 1024 B in return data, ≈ 7 KB through log chunks |
| KV value | 10 000 B JSON per key |
| compute | 400 k CU requested, 1.4 M max |
| clock | seconds |
| rent | 6.96 SOL per MB of static + program bytes, 2 × the `.so` reserved |
| not supported | network, fs, timers, randomness, regex, classes, streaming, `waitUntil`, ISR, crons, middleware, local imports |

## The hosted explorer (`hub`)

`serve` fronts one program on localhost. `hub` fronts every program on a
cluster from one public host, read-only:

```
openzoo-transmute hub --cluster mainnet --port 8080        # or: fly deploy (Dockerfile + fly.toml here)
https://<host>/s/<programId>        pins that site (cookie) and opens its /
https://<host>/s/<programId>/api/x  one page of it, absolute
https://<host>/.hub                 paste a program id; recently served sites
```

Reads are free simulations, exactly as in `serve`. Writes answer 402 on a
public host (a shared signer would be drained); use `serve` with your wallet
locally, or the x402-paid lane once the openzoo proxy fronts it. The site's
own root-relative links keep working because the pinned program rides a
cookie, so a transmuted app needs no base-path changes.

## Roadmap

* **Browser fork / `sol://` scheme** — a browser that resolves
  `sol://<programId>/path` straight from the RPC (assets from PDAs, `/api/*`
  through `simulateTransaction`), so a site needs no gateway and no domain.
* **x402-paid writes through the openzoo proxy** — the gateway already answers
  `402` with an `x402` stub for mutating requests when it has no signer; next is
  letting the openzoo proxy pay per request from the burner wallet so a public
  gateway never holds keys.
* **Chunked request bodies** — bodies > 900 B staged into a request account over
  several transactions (the same mechanism assets already use), then referenced
  by the invoke.
* **Response accounts** — responses > ~7 KB written into a per-request account
  and read back by the gateway, instead of the log buffer.
* Compiler coverage: local imports, `RegExp`, base64 (`atob`/`btoa`), `cookies()`,
  `URLSearchParams`, more of `@vercel/kv` (`hget`, lists, `expire`).

License: MIT.
