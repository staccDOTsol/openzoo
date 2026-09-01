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
export function payBannerLines({ solana, evm, balances = null, whop = 'https://whop.com/staccoverflow/openzoo', chromeMode = 'own-profile' } = {}) {
  const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4)}` : '?');
  const lines = [
    'openzoo: HOW TO PAY — no account, no API key, every call is paid from this wallet:',
    `         Solana  ${solana}`,
    '                 send USDC or TOKEN here (TOKEN is half price)',
    `         Base    ${evm}`,
    '                 send USDC here',
    balances ? `         balance Solana USDC ${usd(balances.USDC)} · TOKEN ${balances.TOKEN_UNITS != null ? `${balances.TOKEN_UNITS} units` : '?'} · Base USDC ${usd(balances.BASE_USDC)}   (recheck: openzoo balance)` : '         balance unknown right now — run: openzoo balance',
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
