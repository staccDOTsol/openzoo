/**
 * What `openzoo bot` prints to a first-time user's terminal.
 *
 * MEASURED 2026-09-01 on a fresh macOS account: the console was ~60 lines of
 * `#N POST /aiserver.v1.…`, `cursor-tls: connected`, `-> empty-ok`, `/health`
 * before the app even painted, and nothing said how to pay. The human's words:
 * "onboarding is not great mate" / "it's not telling me straight up how to pay".
 *
 * Default is QUIET: only milestones and problems. `--verbose` / OPENZOO_DEBUG=1
 * restores the firehose (it is still the right thing for debugging the wire).
 */
import { privateKeyToAccount } from 'viem/accounts';

const NOISE = [
  /^cursor-backend: #\d+ (GET|POST|PUT|DELETE) /,
  /^cursor-tls:/,
  /-> empty-ok/,
  /-> pod /,
  /-> transcript /,
  /-> getHostStatus/,
  /-> GetMe/,
  /-> WatchSandBoxMigration/,
  /GetGrokBotSendStatus/,
  /listAgents local n=/,
  /discovered roster/,
  /SNIFF real pod/,
  /POST \/oauth\/token/,
  /mcp \S+ (chrome-devtools-mcp exposes|Performance tools|\[chrome-devtools-mcp\] The connecting client)/,
  /ProofNetwork MCP server running/,
];

const MILESTONE = [
  /mcp ready/,
  /mcp \S+ (mode=|FAIL|tools=\d+|re-attach|attached|appeared)/,
  /mcp \S+ To let bots drive your real Chrome/,
  /x402 402|upstream outage|underfunded|wallet/i,
  /ERROR|FAIL|uncaught|rejection|timed out/,
  /wakeups restored|wakeup fire/,
  /ozRevive|ship_|ship:/,
  /sendPrompt done/,
  /create_agent tool|deleteAgents n=/,
  /x_compose|chrome reattach/,
];

/** Pure: should this backend line reach a quiet terminal? */
export function isBotMilestone(line) {
  const s = String(line || '');
  if (NOISE.some((re) => re.test(s))) return false;
  return MILESTONE.some((re) => re.test(s));
}

export function makeBotLogger({ verbose = false, write = (m) => console.error(m) } = {}) {
  return (m) => {
    if (verbose || isBotMilestone(m)) write(`  backend: ${m}`);
  };
}

/**
 * The block a new user needs before anything else. `balances` is optional
 * ({ USDC, TOKEN } in USD) — printed as `?` when unknown so nothing is invented.
 */
export const MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  TOKEN: 'EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump',
  LEOS: '5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e',
  BASE_USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};
export function payBannerLines({ solana, evm, balances = null, whop = 'https://whop.com/staccoverflow/openzoo', chromeMode = 'own-profile', mints = MINTS } = {}) {
  const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4)}` : '?');
  const units = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v} units` : '?');
  const lines = [
    'openzoo: HOW TO PAY — no account, no API key, every call is paid from this wallet:',
    `         Solana  ${solana}`,
    '                 send any of these here:',
    `                   USDC   ${mints.USDC}`,
    `                   TOKEN  ${mints.TOKEN}   (half price)`,
    `                   LEOS   ${mints.LEOS}   (half price)`,
    `         Base    ${evm}`,
    `                   USDC   ${mints.BASE_USDC}`,
    balances ? `         balance Solana USDC ${usd(balances.USDC)} · TOKEN ${units(balances.TOKEN_UNITS)} · LEOS ${units(balances.LEOS_UNITS)} · Base USDC ${usd(balances.BASE_USDC)}   (recheck: openzoo balance)` : '         balance unknown right now — run: openzoo balance',
    `         card    ${whop}  — paste the Solana address above when it asks`,
  ];
  if (chromeMode === 'own-profile') {
    lines.push('openzoo: CHROME  bots open a blank Chrome until you flip chrome://inspect/#remote-debugging → "Allow remote debugging for this browser", then restart openzoo bot. After that they drive YOUR logged-in Chrome.');
  } else {
    lines.push(`openzoo: CHROME  attached to your real browser (${chromeMode}).`);
  }
  lines.push('openzoo: FIRST   type in any bot: "set up Grok Ship for ~/path/to/repo"  — or just give it work.');
  lines.push('openzoo: QUIET   add --verbose to see every request the app makes.');
  return lines;
}

export function walletAddresses(wallet) {
  return {
    solana: wallet.keypair.publicKey.toBase58(),
    evm: privateKeyToAccount(wallet.evmPrivateKey).address,
  };
}

/** Live balances for the banner: Solana USDC/TOKEN/LEOS + Base USDC. Never throws; unknowns are null. */
export async function quickBalances(addrs, { timeoutMs = 6000 } = {}) {
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const out = { USDC: null, TOKEN_UNITS: null, LEOS_UNITS: null, BASE_USDC: null };
  try {
    const { Connection } = await import('@solana/web3.js');
    const { config, FUNDING_ASSETS } = await import('./config.js');
    const { tokenBalance } = await import('./x402.js');
    const { loadOrCreateWallet } = await import('./wallet.js');
    const w = loadOrCreateWallet();
    const conn = new Connection(config.rpcUrl, 'confirmed');
    const find = (sym) => FUNDING_ASSETS.find((a) => a.symbol === sym);
    const [u, t, l] = await within(Promise.all(['USDC', 'TOKEN', 'LEOS'].map((sym) => (find(sym) ? tokenBalance(conn, w.keypair.publicKey, find(sym).mint) : { ui: 0 }))), timeoutMs);
    out.USDC = Number(u?.ui ?? 0);
    out.TOKEN_UNITS = t?.ui != null ? Number(t.ui) : null;
    out.LEOS_UNITS = l?.ui != null ? Number(l.ui) : null;
  } catch { /* solana unreachable */ }
  try {
    const { evmRpcFor, EVM_FUNDING_ASSETS } = await import('./config.js');
    const { evmTokenBalance } = await import('./evm.js');
    const b = (EVM_FUNDING_ASSETS.base || []).find((a) => a.symbol === 'USDC');
    if (b) {
      const r = await within(evmTokenBalance({ rpcUrl: evmRpcFor('base'), owner: addrs.evm, token: b.address }), timeoutMs);
      const raw = typeof r === 'object' && r !== null ? (r.raw ?? r.ui ?? 0) : r;
      out.BASE_USDC = Number(raw) / 10 ** (b.decimals ?? 6);
    }
  } catch { /* base unreachable */ }
  return out;
}

/** The banner as a chat message: same facts, no terminal prefixes. */
export function payBannerChat(opts) {
  return ['[how to pay]', ...payBannerLines(opts).map((l) => l.replace(/^openzoo: /, '').replace(/^ {9}/, ''))].join('\n');
}
