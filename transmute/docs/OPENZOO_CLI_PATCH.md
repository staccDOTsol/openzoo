# Mounting `build` / `deploy` / `serve` in `npx openzoo`

The openzoo CLI (`staccDOTsol/openzoo`, `bin/openzoo.js`) gains four
subcommands that delegate to this package. Nothing is duplicated: `openzoo`
forwards its argv to `openzoo-transmute/lib/cli.js`, whose `run(argv)` resolves
to the exit code, sets `process.exitCode` when non-zero and never calls
`process.exit` itself (so `serve` keeps the event loop — and its HTTP server — alive).

Two files change.

**Status.** openzoo's `transmute-cli` branch carries hunk 1 (`bin/openzoo.js`,
byte-identical to the diff below) and nothing else. Hunk 2 waits for
`openzoo-transmute` to be published: `npm view openzoo-transmute` is a 404
today, so both the `"openzoo-transmute": "^0.1.0"` dependency and the
`npx --yes openzoo-transmute@latest` fallback fail on a fresh machine. Until
then, install the package from its path so the `import('openzoo-transmute/lib/cli.js')`
branch resolves: `npm install /path/to/leCore/openzoo-transmute` inside the
openzoo checkout (or `npm link` in that directory, then `npm link openzoo-transmute`).

## 1. `bin/openzoo.js`

```diff
--- a/bin/openzoo.js
+++ b/bin/openzoo.js
@@ -169,6 +169,16 @@
   npx openzoo contexts --forget <hash|all>   drop manifest entries
   npx openzoo balance    wallet balance on every rail — Solana (USDC/TOKEN/SOL),
                          Base (USDC/ETH), Robinhood Chain (USDG/memecoins/ETH)
+  npx openzoo build [dir]     transmute a Vercel-shaped app (Next.js pages/api,
+                              app/**/route, Vite + api/*) into a Pinocchio Rust
+                              program + asset plan (--out .zoo-out --arch v0|v3)
+  npx openzoo deploy [dir]    deploy the program and the static frontend to
+                              Solana accounts (--cluster mainnet|devnet|localnet,
+                              --yes to accept the rent estimate; burner wallet)
+  npx openzoo serve <program> local gateway/explorer for a deployed site
+                              (--cluster, --port 4402); /api/* reads are free
+                              simulations, writes are signed by the burner
+  npx openzoo inspect [dir]   print the app in Vercel terms + eligibility report
   npx openzoo address    print both funding addresses (Solana + EVM)
   npx openzoo help       this text
 
@@ -403,6 +413,33 @@
       if (bal <= 0) console.log('buy some with:  npx openzoo topup 10');
       break;
     }
+    case 'build':
+    case 'deploy':
+    case 'serve':
+    case 'inspect':
+    case 'transmute': {
+      // VERCEL-SHAPED APP -> SOLANA MAINNET. `openzoo build|deploy|serve` hand
+      // the argv to openzoo-transmute (a sibling npm package): it reads the
+      // app the way `vercel build` would (pages/api, app/**/route, api/*,
+      // .vercel/output), transmutes each Lambda into a Pinocchio Rust program
+      // route, stores the static build in asset accounts, deploys with the
+      // burner wallet at ~/.openzoo/wallet.json, and `serve` runs the local
+      // gateway/explorer that maps http://localhost:4402/... onto the program.
+      // Dynamic import so a machine without the package still runs every other
+      // command; the fallback shells out to npx so the very first `openzoo
+      // deploy` works before the dependency is pinned in package.json.
+      const argv = process.argv.slice(2).map((a, i) => (i === 0 && a === 'transmute' ? 'help' : a));
+      let cli = null;
+      try { cli = await import('openzoo-transmute/lib/cli.js'); } catch { /* not installed alongside */ }
+      if (cli) {
+        await cli.run(argv);
+      } else {
+        const { spawnSync } = await import('child_process');
+        const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'openzoo-transmute@latest', ...argv], { stdio: 'inherit' });
+        process.exit(r.status === null ? 1 : r.status);
+      }
+      break;
+    }
     case 'address':
       (await import('../lib/info.js')).printAddress();
       break;
```

The first hunk lands inside the `HELP` template literal, right after the
`balance` lines and before `address`; the second goes into `main()`'s `switch
(cmd)` between the `credits` and `address` cases. `openzoo transmute` with no
further arguments is rewritten to `help` so it prints this package's usage.

## 2. `package.json`

```diff
--- a/package.json
+++ b/package.json
@@ -21,9 +21,10 @@
   "dependencies": {
     "@modelcontextprotocol/sdk": "^1.12.0",
     "@solana/spl-token": "^0.4.14",
     "@solana/web3.js": "^1.98.4",
     "dugite": "^3.2.3",
+    "openzoo-transmute": "^0.1.0",
     "selfsigned": "^5.5.0",
     "viem": "^2.21.0",
     "zod": "^3.24.0"
   },
```

`openzoo-transmute`'s `package.json` has no `exports` map, so the deep import
`openzoo-transmute/lib/cli.js` resolves as a plain file; both packages already
depend on `@solana/web3.js ^1.98.4`, so one copy is installed. Until the
dependency is pinned, the `catch` branch above shells out to
`npx --yes openzoo-transmute@latest …`, so `npx openzoo deploy` works on a
fresh machine either way — once the package is on npm (see *Status* above).

## The wallet

Nothing to configure. `openzoo-transmute/lib/wallet.js::loadWallet()` looks, in order, at

1. `--keypair <path>`
2. `$OPENZOO_KEYPAIR`
3. `$OPENZOO_WALLET`, else **`~/.openzoo/wallet.json`** — the openzoo burner
   wallet, in either of its shapes: `{ "solana": [64 bytes], ... }` (what
   `npx openzoo address` creates) or a bare `solana-keygen` array
4. `~/.config/solana/id.json` (the Solana CLI keypair)

so a user who has run `npx openzoo address` already has the signer `deploy` and
`serve` will use, and the same `OPENZOO_WALLET` / `OPENZOO_RPC` variables
listed in openzoo's `HELP` apply. `OPENZOO_CLUSTER` selects the cluster
(`mainnet` by default; `deploy` refuses mainnet without `--yes` after printing
the rent sheet). The mainnet RPC default is the one the openzoo proxy uses
(`lib/config.js` `rpcUrl`), overridable with `OPENZOO_RPC`.

## Checking the patch

```sh
npm install                                 # pulls openzoo-transmute (or: npm install /path/to/leCore/openzoo-transmute)
node bin/openzoo.js help | grep -A1 'openzoo build'
node bin/openzoo.js transmute               # prints openzoo-transmute's usage
node bin/openzoo.js inspect ./my-app        # Vercel model + eligibility, no chain access
node bin/openzoo.js build ./my-app --skip-cargo   # crate + cost sheet without the Solana toolchain
node bin/openzoo.js deploy ./my-app --cluster devnet
node bin/openzoo.js serve --cluster devnet  # program id from ./my-app/.zoo-out/.zoo/deploy.json
```

Exit codes come back from `run()`: `0` ok, `1` error (message on stderr,
`OPENZOO_DEBUG=1` for the stack), `2` when `build` found nothing eligible.
