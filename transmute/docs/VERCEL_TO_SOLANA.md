# Vercel → Solana: the reverse-engineering document

This is the contract openzoo-transmute re-hosts, written in Vercel's own terms.
A Vercel deployment is a `config.json` route table, a `static/` tree and a set
of AWS Lambdas that speak the `@vercel/node-bridge` protocol. Each of those
three things has an exact counterpart on Solana, and every claim below points
at the file that implements it:

| Vercel piece | This package | On chain |
|---|---|---|
| Build Output API v3 reader / synthesizer | `lib/vercel.js` | — |
| bridge Invoke event / response as bytes | `lib/wire.js` ↔ `runtime/zoo-host/src/wire.rs` | instruction data, return data + `sol_log_data` |
| the `req`/`res` helper surface | `runtime/zoo-host/src/ctx.rs` | `Ctx` methods called by generated Rust |
| JS value semantics | `runtime/zoo-host/src/val.rs`, `json.rs` | `Val` enum |
| `@vercel/kv` | `runtime/zoo-host/src/kv.rs` | KV PDAs |
| `static/` | `runtime/zoo-host/src/assets.rs`, `lib/solana.js` | asset PDAs |
| deploy / upgrade / invoke client | `lib/solana.js` | BPF upgradeable loader, `simulateTransaction`, signed txs |
| signer discovery, cluster URLs | `lib/wallet.js` | — |
| `config.json` routes, `cleanUrls`, 402/413 seams | `lib/gateway.js` | — (local HTTP front) |
| eligibility rules | `lib/eligibility.js`, `lib/compile/` | — |

---

## 1. What `vercel build` emits (Build Output API v3)

`vercel build` (or a framework's `@vercel/*` builder) writes `.vercel/output/`:

```
.vercel/output/
  config.json                         { version: 3, routes, overrides, cache, crons, wildcard, images, framework }
  static/**                           served verbatim; wins once routing reaches `handle: "filesystem"`
  functions/<name>.func/
    .vc-config.json                   the Lambda's configuration (below)
    index.js | <bundle>               the handler (`handler`) or edge module (`entrypoint`)
  functions/<name>.prerender-config.json      ISR: { expiration, group, bypassToken, fallback, allowQuery }
  functions/<name>.prerender-fallback.html    ISR: the fallback body
```

### `config.json`

| field | meaning | what happens to it here |
|---|---|---|
| `version` | must be `3` | `lib/vercel.js` synthesizes `{version: 3}` when there is no `.vercel/output` |
| `routes[]` | ordered `{src, dest, headers, status, methods, continue, caseSensitive, has, missing, check, important}` and phase markers `{handle: "filesystem" / "miss" / "rewrite" / "resource" / "hit" / "error"}` | carried into the manifest; `lib/gateway.js` evaluates them in Vercel's phases (`routePhases`): pre-filesystem → static → post-filesystem → function → error |
| `overrides` | `{ "<static path>": {path, contentType} }` | not applied (static content types come from the extension, `contentTypeFor`) |
| `crons[]` | `{path, schedule}` | reported and refused: nothing on Solana schedules an instruction (`deploymentWarnings`) |
| `wildcard[]` | `{domain, value}` per-domain rewrites | n/a: there is no domain, only a program id |
| `images` | image optimization config | n/a |
| `framework` | `{slug, version}` | recorded in the manifest |

### `functions/<name>.func/.vc-config.json`

This is the Lambda. Every field is modelled by `VercelFunction` in `lib/vercel.js`
(defaults in parentheses are what `readNextjs` / `readVercelNode` fill in when
synthesizing the model from a source tree):

| field | Vercel meaning | Solana counterpart |
|---|---|---|
| `runtime` (`nodejs20.x`) | Lambda runtime; `edge` for Edge Functions | must be `nodejs*.x` or `edge`; any other runtime (python, go, ruby) is ineligible |
| `handler` (`index.js`) | Lambda handler module | the file the transmuter reads |
| `entrypoint` | Edge Function module | same, for `runtime: "edge"` |
| `launcherType` (`Nodejs`) | which launcher wraps the handler | implied: the generated Rust route *is* the launcher |
| `shouldAddHelpers` (`true`) | wrap `req`/`res` with `req.query`/`req.body`/`req.cookies`, `res.status`/`json`/`send`/`redirect` | `Ctx` always provides the helper surface (§2) |
| `maxDuration` (`10` s) | wall-clock budget | compute-unit limit (`DEFAULT_CU = 400_000` in `lib/solana.js`; 1.4 M per tx max). Seconds are meaningless: `maxDuration > 60` triggers a warning |
| `memory` (`1024` MB) | Lambda RAM | heap frame: `ComputeBudgetProgram.requestHeapFrame(256 KiB)` (`DEFAULT_HEAP`), the SBF maximum |
| `regions` (`["iad1"]`) | where the Lambda is placed | n/a: every validator runs the same program |
| `environment` | env vars injected into the Lambda | a `const ENV: &[(&str, &str)]` table baked into the `.so` (`dispatch(..., env)` in `lib.rs`); `.env*` files are folded in by `applyEnv` — **they become public bytes on chain** |
| `supportsResponseStreaming` | stream the response as it is produced | ineligible: an instruction answers once (§3) |
| `operationType` (`API`) | `API` / `Page` / `ISR` | informational |
| `architecture` | `x86_64` / `arm64` | SBPF; `--arch v0` (mainnet) or `v3` (test validator), see `detectSbpfArch` |
| `framework` | `{slug, version}` | recorded |
| `middleware` (derived) | `middleware.{js,ts}` at the project root, runs on the edge before routing | ineligible: the gateway routes directly (`functionMetaReason`) |
| `prerender` (derived) | `<name>.prerender-config.json` exists | ineligible: an ISR function is a page cache, not an API handler |

### How the model is obtained without running `vercel build`

`readDeployment(root)` in `lib/vercel.js` picks a reader:

| source | trigger | functions | static |
|---|---|---|---|
| `build-output` | `.vercel/output/config.json` exists | every `functions/**.func` with its `.vc-config.json` | `.vercel/output/static/**` |
| `nextjs` | `next` in package.json, a `next.config.*`, or `pages/api` / `app` | `pages/api/**` (pages style) and `app/**/route.{js,ts}` (app style, HTTP-method exports detected); `middleware.{js,ts}` | `out/` (after `next build` with `output: 'export'`), else `public/` |
| `vercel-node` | anything else with an `api/` dir (Vite, plain static + `@vercel/node`) | `api/**` | first of `vercel.json.outputDirectory`, `dist`, `build`, `public`, `.` that holds an `index.html` |

`routeFromFile` turns `api/users/[id].ts` into Vercel's `{routePath: "/api/users/[id]", pattern: "^/api/users/([^/]+)/?$", params: ["id"]}`,
including `[...slug]`, `[[...slug]]` and app-router `(groups)`. The synthesized
`config.routes` is `vercel.json.rewrites` → `{handle: "filesystem"}` → one
`{src: pattern, dest: routePath}` per function, which is the order `@vercel/next`
and `@vercel/node` emit.

---

## 2. What the AWS Lambda actually receives

Vercel does not hand your handler an HTTP socket. `@vercel/node` bundles it
behind a launcher and `@vercel/node-bridge`; the Lambda is invoked with:

```jsonc
// Lambda event
{ "Action": "Invoke",
  "body": "{\"method\":\"POST\",\"path\":\"/api/items?limit=5\",\"headers\":{\"content-type\":\"application/json\",\"x-vercel-id\":\"iad1::abc\"},\"encoding\":\"base64\",\"body\":\"eyJhIjoxfQ==\"}" }
```

and must return:

```jsonc
// Lambda result
{ "statusCode": 200,
  "headers": { "content-type": "application/json; charset=utf-8" },
  "encoding": "base64",
  "body": "eyJvayI6dHJ1ZX0=" }
```

The bridge turns the event into a Node `IncomingMessage`, runs the handler, and
serializes the `ServerResponse` back. That pair of records is the whole
contract, and it is what `lib/wire.js` / `wire.rs` encode:

```text
instruction data                       response bytes
[u8 tag=0 INVOKE]                      [u16 status]
[u8 route]      index into ROUTES      [u16 headers_len][headers "name:value\n"...]
[u8 method]     GET0 POST1 PUT2        [u32 body_len][body]
                DELETE3 PATCH4
                OPTIONS5 HEAD6         emitted as set_return_data(first 1024 B)
[u16 path_len][path]                   + sol_log_data ["ZOOR", u16 idx, ≤900 B] chunks
[u16 query_len][query]  (no '?')
[u16 headers_len][headers "name:value\n", lowercase]
[u32 body_len][body]
```

`encodeInvoke` forwards only the headers that matter on chain
(`FORWARDED_HEADERS`: `content-type authorization accept cookie user-agent
x-forwarded-for x-real-ip x-vercel-id` plus any `x-*`); a transaction is 1232
bytes and every header byte is a body byte lost.

### What the helpers add, and their `Ctx` counterparts

With `shouldAddHelpers: true` the launcher decorates `req`/`res`. The generated
Rust calls these `Ctx` methods (`runtime/zoo-host/src/ctx.rs`) instead:

| Vercel helper (pages / `@vercel/node`) | semantics | `Ctx` |
|---|---|---|
| `req.method`, `req.url` | as Node sees them (`url` = path + `?query`) | `req_method()`, `req_url()`, `req_path()` |
| `req.query` | parsed search params; Vercel turns a repeated key (`?a=1&a=2`) into an array | `req_query()` (`val::parse_query`): URL-decoded string values, **last value wins** for a repeated key |
| `req.headers[name]` | lowercase names | `req_headers()`, `req_header(&name)` → string or `null` |
| `req.body` | parsed by `content-type`: `application/json` → object, `application/x-www-form-urlencoded` → object, otherwise string; empty → `undefined` | `req_body()` (no content type: tries JSON, falls back to the string) |
| `req.cookies` | parsed `cookie` header | `req.cookies.<name>` compiles to a generated cookie-parsing helper over `req_header("cookie")`; `next/headers` `cookies()` is ineligible for now |
| `res.status(code)` | set status, chainable | `res_status(&code)` (100–999) |
| `res.json(obj)` | `application/json; charset=utf-8` | `res_json(&v)` |
| `res.send(body)` | string / object / Buffer | `res_send(&v)`: string → `text/html; charset=utf-8` unless set; object/array/number/bool → json; `null`/`undefined` → empty |
| `res.end(text?)` | finish | `res_end(&v)` |
| `res.redirect([status,] url)` | default **307** | `res_redirect(&status, &url)` |
| `res.setHeader(k, v)` | | `res_header(&k, &v)` |

App-router (`app/**/route.ts`) handlers get the fetch-style pair instead:

| app router / `next/server` | `Ctx` |
|---|---|
| `new URL(request.url)` | `req_full_url()` — origin is the synthetic `https://zoo.sol`, only path + search are real |
| `request.nextUrl.searchParams.get(k)` (also `has`, `getAll`, `entries`, `keys`, `values`, `toString`) | `req_query_get(&k)` → string or `null`; the rest are lowered over `req_query()` |
| `request.headers.get(k)` / `.has(k)` | `req_header(&k)` |
| `request.cookies.get(k)` / `.has(k)` / `.getAll()` | the same generated cookie helper |
| `{ params }` (second argument), `params.id` | the route's dynamic segments, delivered by the gateway as `x-zoo-param-<name>` request headers (`PARAMS_N` in the generated route); a name that is not a segment of the route is a warning and reads `undefined` |
| `await request.text()` / `.json()` | `req_text()` / `req_json()` (throws `SyntaxError` on a malformed body, like fetch) |
| `Response.json(body, init)` / `NextResponse.json` | `respond_json(&body, &init)` — `init.status`, `init.headers` applied |
| `new Response(body, init)` / `new NextResponse` | `respond(&body, &init)` — default `text/plain; charset=utf-8` |
| `NextResponse.redirect(url, status)` | `respond_redirect(&url, &status)` (default 307) |
| `process.env.X` | `env(&"X")` / `env_obj()` from the baked table |
| `Date.now()` / `new Date().toISOString()` | `now_ms()` / `now_iso()` — the Clock sysvar, **second** resolution; `slot()` is also available |
| `throw new Error(msg)` | `Err(Ctx::new_error(&[msg]))` |

Outcome semantics mirror the bridge (`lib.rs::invoke`):

| handler outcome on Vercel | Vercel answer | here |
|---|---|---|
| uncaught throw / rejected promise | 500 `FUNCTION_INVOCATION_FAILED` | `Err(thrown)` → 500 `{"error": <message>}` |
| returns without ever ending the response | 504 (`FUNCTION_INVOCATION_TIMEOUT` when the wait expires) | `!cx.sent` → 504 `{"error":"handler returned without a response"}` |
| `res.status(404).json(...)` | 404 | 404, byte for byte |

---

## 3. What Fluid Compute changes, and why it does or does not map

Fluid Compute (Vercel's 2025 execution model) keeps the bridge contract but
changes what one Lambda instance may do:

| Fluid Compute feature | what it is | maps? | why |
|---|---|---|---|
| in-function concurrency | one instance serves many invocations at once; idle `await`s overlap | **n/a** | a Solana instruction is one synchronous execution in one transaction; concurrency is between transactions, handled by the runtime's account locks (two writes to the same KV PDA serialize; reads never block) |
| `waitUntil` / `after()` | keep running after the response was sent | **no** | nothing runs after `set_return_data`; `@vercel/functions` and `next/server.after` are ineligible imports (`ALLOWED_IMPORTS`) |
| response streaming | flush bytes while computing | **no** | the response is one byte string emitted at the end of the instruction; `supportsResponseStreaming` marks the function ineligible |
| bytecode caching / warm instances | faster cold starts | **none needed** | there is no cold start: the program is already loaded on every validator; latency is one RPC round trip (simulate) or one confirmation (write) |
| "Active CPU" pricing | pay for CPU time, not wall time | **compute units** | you pay for CU (bounded by the CU limit) on writes, and nothing on reads |
| multi-region, failover | run in many regions | **inherent** | every validator runs the program; the gateway picks an RPC |
| 800 s `maxDuration` | long tasks | **no** | one transaction, ≤ 1.4 M CU (a few ms of CPU) |
| background jobs / cron | `crons` in `config.json` | **no** | no scheduler; someone must send the transaction |

---

## 4. Mapping table

| Vercel term | Solana term | where |
|---|---|---|
| Lambda (`functions/<name>.func`) | route index into the program's `ROUTES: &[Route]` table; one `fn route_N(cx: &mut Ctx) -> Result<(), Val>` | generated `src/lib.rs`, `zoo_host::dispatch` |
| launcher + `@vercel/node-bridge` | `zoo_host::dispatch` (parse → route → encode → emit) | `runtime/zoo-host/src/lib.rs` |
| bridge Invoke event `{method, path, headers, body}` | instruction data `[0][route][method][path][query][headers][body]` | `lib/wire.js::encodeInvoke`, `wire.rs::parse_req` |
| bridge response `{statusCode, headers, body}` | return data (≤1024 B) + `ZOOR` log chunks, reassembled by `parseLogs` | `wire.rs::emit`, `lib/wire.js::parseLogs` |
| GET / HEAD / OPTIONS | `simulateTransaction` — free, unsigned, `sigVerify: false` | `lib/solana.js::invoke` (`mutate: false`), `gateway.js::READ_METHODS` |
| POST / PUT / DELETE / PATCH | a signed transaction; response read back from the confirmed transaction's logs | `invoke` (`mutate: true`) |
| `maxDuration` | `setComputeUnitLimit` (400 k default, 1.4 M max) | `DEFAULT_CU` |
| `memory` | `requestHeapFrame` (256 KiB max) | `DEFAULT_HEAP` |
| `regions` | n/a | — |
| `environment` / `.env.production` | `const ENV` baked into the `.so` | `applyEnv`, `dispatch(env)` |
| `static/` | one asset PDA per file: `["asset", sha256("zoo-asset" ‖ path)]`, data `[1][bump][u32 total][u8 ct_len][ct][bytes]`, rent-exempt | `assets.rs`, `putAsset` / `readAsset` |
| `config.json` routes / `cleanUrls` / `handle: filesystem` | the local gateway | `lib/gateway.js` |
| `@vercel/kv` (`get set incr incrby decr decrby del exists`) | KV PDAs: `["kv", sha256("zoo-kv" ‖ key)]`, data `[1][bump][u32 len][JSON]`, created on first write, paid by the request's payer | `kv.rs`, `KV_METHODS` |
| ISR / `prerender-config.json` | unsupported: no revalidation, no page cache; ship the rendered HTML as static instead | `functionMetaReason` |
| `crons` | unsupported: no scheduler | `deploymentWarnings` |
| middleware | unsupported: the gateway routes directly | `functionMetaReason` |
| streaming / `waitUntil` | unsupported: one synchronous answer | §3 |
| cold start | none | — |
| Vercel logs / `console.log` | program logs (`Program log:` lines); the gateway returns the last 25 on a 502 | `wire.rs::log_str`, `gateway.js` |
| deployment URL `https://x.vercel.app` | program id + gateway origin `http://127.0.0.1:4402/`; the site manifest is the asset `/.zoo/manifest.json` | `MANIFEST_PATH`, `deploy.js` |
| `vercel deploy` (new) | BPF upgradeable loader: buffer → `DeployWithMaxDataLen(2 × .so)`; invokable one slot later | `deployProgram`, `waitForProgram` |
| `vercel deploy` (again) | `Upgrade` through a fresh buffer, same program id, unchanged assets skipped by byte comparison | `upgradeProgram`, `putAsset` |
| `vercel rollback` | none; re-upgrade with the older `.so` | — |
| deployment protection / team auth | the program's upgrade authority (writes to assets/program); route invocations are open to any payer, exactly like a public URL | `check_authority` |
| request id `x-vercel-id` | `x-zoo-nonce` header (write dedupe + request id in logs), transaction signature (`x-zoo-signature`) | `invoke`, `gateway.js` |
| function duration / CU billed | `unitsConsumed` (`x-zoo-cu` header) | `gateway.js` |

---

## 5. Eligibility rules and hard limits

### Byte and compute budgets

| limit | value | reason | where enforced |
|---|---|---|---|
| transaction size | 1232 B (IPv6 MTU 1280 − 40 − 8) | Solana | network |
| request body | **900 B** (path/query/headers share the rest) | 1232 − signature − accounts − compute-budget ixs − headers | `gateway.js::BODY_LIMIT` → 413 |
| forwarded headers | allow-list + `x-*`, no newlines | same budget | `wire.js::encodeHeaders` |
| return data | 1024 B | `sol_set_return_data` | `wire.rs::MAX_RETURN_DATA` |
| response via logs | ≈ 8 chunks × 900 B ≈ **7 KB** | the validator keeps 10 KB of log messages per transaction and each chunk is base64-expanded (`Program data: ZOOR …`) | `wire.rs::LOG_CHUNK`, `parseLogs` |
| compute | 400 k CU requested, 1.4 M max per transaction (200 k is the unrequested default) | Solana | `DEFAULT_CU` |
| heap | 256 KiB (32 KiB without the request) | Solana | `DEFAULT_HEAP` |
| stack | 4 KiB per frame | SBF | deep recursion in a handler traps |
| KV value | **10 000 B** of JSON per key | one account create per CPI ≤ 10 240 B | `kv.rs::MAX_VALUE` |
| KV keys per request | as many PDAs as fit in the transaction (32 B each after the fixed accounts) | 1232 B | `invoke` discovery, `maxDiscovery = 6` rounds |
| asset create | 10 240 B in the first transaction | CPI `create_account` cap | `assets.rs::MAX_INITIAL` |
| asset growth | ≤ 10 240 B per transaction, written in 900 B chunks | realloc cap per instruction | `MAX_GROW`, `WRITE_CHUNK` |
| asset size | up to the 10 MiB account maximum (rent, §6) | Solana | — |
| content type | ≤ 120 B | `u8 ct_len` | `wire.js::encodeAssetInit` |
| program size | `.so` ≤ `maxDataLen` (2 × the first deploy); larger → new program id | loader | `upgradeProgram` |
| routes | ≤ 256 per program | `u8 route` | `encodeInvoke` |
| status | 100–999 | `u16` | `res_status` |
| clock | seconds (`Clock.unix_timestamp`), `Date.now()` rounds to 1000 ms | sysvar | `now_ms` |

### The code subset (`lib/eligibility.js`, `lib/compile/parse.js`, `lib/compile/ir.js`)

A handler is eligible when everything it does can be expressed in the
`zoo-host` subset: pure computation over JS values, the bridge surface, `@vercel/kv`,
the baked environment and the cluster clock. The reason for ineligibility always
carries `file:line`.

| rule | detail |
|---|---|
| no network | `fetch`, `XMLHttpRequest`, `WebSocket`, `http`/`https`/`net`/`dns` — an instruction cannot leave the validator |
| no filesystem / process | `fs`, `path`, `os`, `child_process`, `process.*` beyond `process.env`, `require()` |
| no time or randomness beyond the clock | `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`, `performance`, `crypto`; `Math.random` is not in the accepted `Math.*` set (`MATH_FUNCS`) — validators must agree on the result |
| imports | only `@vercel/kv` (`kv`, `createClient`), `next/server` (`NextResponse`), and the `next` / `@vercel/node` **types**; `next/headers`, `next/cache`, `next/navigation`, `@vercel/edge`, `@vercel/functions` are refused with a reason; local `./helper` imports are not transmuted yet (inline them) |
| handler shape (`lib/compile/parse.js::readModule`) | `export default (req, res)`, `export function GET/POST/…`, `module.exports = fn`, and `export const config = { runtime: 'edge' }` with a web-style `(request) => Response` default export; in an `app/**/route` file the default export is *not* a handler (export the methods). Higher-order wrappers (`withAuth(handler)`) are refused (`resolveHandlerNode`): export the plain handler |
| values | `undefined null boolean number string array object`; numbers are `f64` (`BigInt` refused); no `Map`/`Set`/`Symbol`/typed arrays/`Buffer`/`RegExp`/`Intl`; no classes, generators, `eval`, `Proxy` |
| control flow | `if`/ternary, `for` / `for…of` / `for…in` / `while` / `do`, `switch`, `try/catch/finally`, labeled `break`/`continue` (not across a callback boundary), template literals, destructuring, `?.` and `??`, `typeof`; module-scope `const`s and helper functions. Refused: `with`, `this`, `arguments`, `instanceof`, tagged templates, dynamic `import()`, spread arguments, `obj[name]()` computed method calls, `?.()` |
| built-ins | strings: `toUpperCase toLowerCase trim* includes startsWith endsWith indexOf split slice substring substr charAt charCodeAt replace replaceAll repeat padStart padEnd concat at toString`; arrays: `push pop shift unshift join splice reverse flat flatMap map filter find findIndex some every forEach reduce sort`, `Array.isArray`, `Array.from(x)`, `Array.of`; `toFixed`, `hasOwnProperty`; `Object.keys values entries assign fromEntries hasOwn` (`freeze`/`seal` are no-ops); `Math.*` (floor ceil round trunc abs sqrt pow sign log log2 log10 exp sin cos tan atan2 min max hypot + constants); `Number String Boolean isNaN isFinite parseInt parseFloat encodeURI(Component) decodeURI(Component)`, `Number.isInteger/isNaN/isFinite/isSafeInteger` + constants; `JSON.parse/stringify`; `Date.now()`, `new Date().toISOString()/getTime()`; `console.log/warn/error` → a program log line. Refused with a reason: any other method (`.match`, `.localeCompare`, …), `String.fromCharCode` and every `String.*` static, `new Date(value)`, `Array.from(x, fn)`, `new Array(n)`, `structuredClone`, `atob`/`btoa` |
| callbacks and local functions | `map/filter/find/findIndex/some/every/forEach/reduce/flatMap/sort` take an inline arrow/function or a function declared by name; an inline callback may read **and assign** the enclosing function's variables (`let total = 0; xs.forEach(x => { total += x })` compiles to a Rust closure). A *named* local function that captures a variable is a copied closure, so one that **mutates** a captured variable (`let n = 0; function bump() { n++ }`) is refused (`findMutation` / `freeVars` in `lib/compile/ir.js`, `parse.js`) — return the value instead. Functions are not first-class values otherwise (no storing them in objects, no passing them except as these callbacks) |
| `async` / `await` | accepted and erased: `await kv.get(k)` is a synchronous account read |
| `kv.*` | `get set incr incrby decr decrby del exists`; anything else (`hget`, `lpush`, `expire`, pipelines) is ineligible |
| function metadata | `middleware`, `supportsResponseStreaming`, `prerender`, non-Node runtimes → ineligible; `crons` and `maxDuration > 60` → warnings |
| whole-function granularity | one refused construct makes the whole Lambda ineligible; the rest of the app still builds and `inspect` lists every reason |

---

## 6. Cost model

Solana charges **rent** (a refundable deposit that makes an account
rent-exempt) for bytes that persist, **fees** per signed transaction, and
**nothing** for reads.

### Rent

Rent-exemption on every current cluster is `(128 + bytes) × 6 960 lamports`,
i.e. a fixed 890 880 lamports per account plus **6 960 lamports per byte**.
Measured against the local validator (`getMinimumBalanceForRentExemption`):

| bytes | lamports | SOL |
|---|---|---|
| 0 | 890 880 | 0.00089 |
| 1 | 897 840 | 0.00090 |
| 10 240 (one asset create) | 72 161 280 | 0.0722 |
| 1 000 000 | 6 960 890 880 | **6.96** |
| 1 048 576 (1 MiB) | 7 298 979 840 | 7.30 |

So the rule of thumb is **6.96 SOL per MB**, and `lib/build.js` uses exactly that
(`LAMPORTS_PER_BYTE = 6960`, `ACCOUNT_OVERHEAD_BYTES = 128`) when no RPC is
reachable, or the cluster's real numbers when one is (`estimateCost`,
`source: "rpc"`). What a deployment locks:

| account | bytes | note |
|---|---|---|
| program account | 36 | |
| program data | 45 + **2 × `.so`** | the loader reserves head-room for upgrades (`maxDataLen`) |
| each static file | 7 + `len(content-type)` + size | `ASSET_FIXED_HEADER` |
| `/.zoo/manifest.json` | 7 + ct + JSON | rewritten on every deploy (`deployedAt`) |
| each KV key touched | 6 + JSON, paid by the **payer of the request that created it** | grows/shrinks with the value |
| upgrade buffer | 37 + `.so`, **transient** | refunded when the upgrade lands |

Worked example from the end-to-end run in the scratchpad (`pipeline-e2e-2.log`,
sample site with two routes): `.so` = 191 024 B (v3) → program data 382 093 B →
**2.66 SOL**; `/index.html` 101 B → 0.0016 SOL; `/app.js` 60 B → 0.0013 SOL; the
manifest 939 B → 0.0074 SOL. Total 2.67 SOL, printed by `deploy` before anything
is spent; mainnet is refused without `--yes`.

### Fees

| action | cost |
|---|---|
| GET / HEAD / OPTIONS | **free** (`simulateTransaction`); the fee payer only has to exist |
| write request | 5 000 lamports per signature + optional priority fee; CU are bounded by the limit, not billed extra |
| deploy | one 5 000-lamport tx per 900 B chunk of `.so` (≈ 213 for the sample) + create + deploy |
| asset upload | one tx per 900 B chunk + one init; unchanged files are skipped by comparing bytes on chain |
| `closeAsset` | one tx; rent returns to the authority |

`estimateCost` approximates fees as `5000 × (1 + ⌈so/900⌉ + Σ(1 + ⌈size/900⌉) + 2)`.

### Frozen when the authority is burned

`solana program set-upgrade-authority <id> --final` (or any tool that sets
`upgrade_authority_address = None`) makes the program immutable. Because
`assets.rs::check_authority` requires the ProgramData option byte to be `1`
and the signer to equal the recorded authority, a burned authority also freezes
the frontend: no asset init/write/close can ever succeed again, while KV
writes (performed by the program on behalf of any payer) keep working. That is
the intended "deployed to mainnet" end state — the site is exactly what was
audited, forever, and `upgradeProgram` refuses with `immutable (authority burned)`.

---

## 7. Security notes

| topic | detail | where |
|---|---|---|
| asset writes are authority-gated | `TAG_ASSET_INIT/WRITE/CLOSE` require accounts `[authority signer, ProgramData, asset PDA, system]`; the program derives the ProgramData address itself (`["<program id>"]` under `BPFLoaderUpgradeab1e…`), checks its owner, decodes `UpgradeableLoaderState::ProgramData {slot, Option<authority>}` and compares the 32 bytes with the signer. A forged ProgramData account or a non-signing authority fails with `ERR_NOT_AUTHORITY (0x4b560002)` / `MissingRequiredSignature` | `assets.rs::check_authority` |
| asset PDAs are bound to the path | the client passes the PDA; the program re-derives `["asset", sha256("zoo-asset" ‖ path)]` and rejects a mismatch with `InvalidSeeds`; only program-owned accounts are written | `assets.rs::init/write/close` |
| KV PDAs are keyed by hash | the key never appears on chain, only `sha256("zoo-kv" ‖ key)`; **values are public** (JSON in an account anyone can read with `readKv`). Do not store secrets in KV | `kv.rs`, `lib/wire.js::kvPda` |
| KV accounts cannot be substituted | the program looks the PDA up **by address** in the account list (`kv_slot`), refuses to write through indices 0–1 (payer, system program), and only reads accounts it owns; a caller passing a wrong account simply triggers discovery | `kv.rs::kv_slot`, `kv_read`, `kv_write` |
| discovery by dry run | the gateway never guesses account lists: it simulates, the program logs `ZOOK <pda>` for every key it needed and fails with `ERR_KV_MISSING (0x4b560001)` so nothing half-applied is committed; the gateway appends those PDAs (writable, non-signer) and retries, at most 6 rounds. The set of accounts a request can touch is therefore exactly what the handler asked for | `lib.rs::invoke`, `lib/solana.js::invoke` |
| reads are unsigned | `simulateTransaction` is sent with `sigVerify: false` and no signature; the fee payer must merely exist with lamports. With `--keypair` that is the gateway wallet; without one the gateway uses the program's upgrade authority as a read-only fee payer (`readPayerFor`) — nothing is debited | `lib/solana.js::invoke`, `gateway.js` |
| writes are replayed from committed state | after `sendAndConfirmTransaction` the response is decoded from `getTransaction(...).meta.logMessages`, not from the preflight simulation, so what the client sees is what landed. The `x-zoo-nonce` header makes byte-identical writes inside one blockhash window distinct (otherwise the RPC de-duplicates them as `AlreadyProcessed`) | `invoke` |
| everything in a signed transaction is public forever | forwarded `authorization` / `cookie` headers and request bodies of **write** requests are in the ledger. Reads are simulations and leave no trace on chain, but the RPC operator sees them. Treat bearer tokens on write routes as published | `FORWARDED_HEADERS` |
| baked environment | `.env`, `.env.production`, `.env.local`, `.env.production.local` are compiled into the `.so`, which anyone can dump (`solana program dump`). Keep secrets out; use the environment table for public configuration only | `applyEnv` |
| any payer can call any route | exactly like a public URL. Authorization must live in the handler's logic (a KV allow-list keyed by `payer_address()`, a header check), not in the transport | `Ctx::payer_address` |
| gateway hygiene | client-supplied `x-zoo-param-*` headers are dropped (route params are re-derived from the pattern); bodies > 900 B are refused with 413 before any RPC call; mutating requests without a signer answer 402 with an `x402` stub instead of failing open; invoke errors return 502 with the last 25 program log lines | `gateway.js::forwardedHeaders`, `serveFunction` |
| mainnet guard | `deploy` prints the cost sheet and refuses mainnet without `--yes`; the payer's balance is checked against the estimate before the first transaction; the program keypair is kept at `.zoo/program-keypair.json` (mode 0600) so redeploys upgrade in place | `lib/deploy.js` |
| SBPF version | `detectSbpfArch` reads the `5cC3foj7…` (SBPF v3) and `B8JJXCy5…` (disable v0 deploy) feature accounts; mainnet (Sept 2026) is v0, a test validator is v3. `deploy` rebuilds if the `.so` was built for the other arch | `lib/solana.js` |

---

## Appendix: byte layouts

```text
KV account      [u8 ver=1][u8 bump][u32 len][len bytes JSON]          seeds ["kv", sha256("zoo-kv" ‖ key)]
asset account   [u8 ver=1][u8 bump][u32 total][u8 ct_len][ct][bytes]  seeds ["asset", sha256("zoo-asset" ‖ path)]
ASSET_INIT      [1][32 hash][u32 total][u8 ct_len][ct]                accounts [authority, programData, pda, system]
ASSET_WRITE     [2][32 hash][u32 offset][bytes]                       same
ASSET_CLOSE     [3][32 hash]                                          same
INVOKE          [0][u8 route][u8 method][u16 path][u16 query][u16 headers][u32 body]
                accounts [payer signer, system program, ...KV PDAs (writable)]
ZOOR chunk      sol_log_data ["ZOOR", u16 idx LE, ≤900 bytes]
ZOOK line       sol_log_data ["ZOOK", 32-byte PDA]
errors          0x4b560001 ERR_KV_MISSING  0x4b560002 ERR_NOT_AUTHORITY  0x4b560003 ERR_BAD_WIRE
```
