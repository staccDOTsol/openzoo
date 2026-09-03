import crypto from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evmChainId, paymentEnvelope, encodeEnvelope } from './x402.js';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const evmClients = new Map();
function clientFor(rpcUrl) {
  if (!evmClients.has(rpcUrl)) evmClients.set(rpcUrl, createPublicClient({ transport: http(rpcUrl) }));
  return evmClients.get(rpcUrl);
}

/** ERC-20 balance (raw bigint) of `owner` for `token` on the chain at `rpcUrl`. */
export async function evmTokenBalance({ rpcUrl, token, owner }) {
  return clientFor(rpcUrl).readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
}

/** Native gas balance (wei bigint) of `owner` on the chain at `rpcUrl`. */
export async function evmNativeBalance({ rpcUrl, owner }) {
  return clientFor(rpcUrl).getBalance({ address: owner });
}

/**
 * EVM rails (Base eip155:8453; Robinhood Chain eip155:4663 behind OPENZOO_ENABLE_RH).
 *
 * x402 EVM "exact" scheme: an EIP-3009 transferWithAuthorization typed-data
 * signature; the facilitator submits it. The envelope (paymentEnvelope in
 * x402.js) carries `resource` and the verbatim `accepted` row alongside the
 * payload — a CDP facilitator validates the payload against a schema and
 * answers "'paymentPayload' is invalid: must match one of [x402V2Pay…]"
 * without either, before it looks at the money. MEASURED 2026-08-25.
 *
 * The typed data is still signed against the chain id parsed from the ROW's
 * network: `verifyNetworkFor` may rewrite the envelope's network to whatever
 * the verifier enforces ("base"), but the EIP-712 domain has to name the chain
 * the token actually lives on or the signature recovers to nobody.
 *
 * IMPORTANT — the decimals landmine does not exist here BY CONSTRUCTION:
 * authorization.value is the raw uint256 straight from maxAmountRequired.
 * We never scale by decimals, so the zoo's /prompt.txt "decimals = 6" bug
 * (wrong for the 18-decimal Robinhood mints) cannot bite this path.
 *
 * STATUS: live. Real payments have settled on both EVM rails (2026-08-14):
 * native USDC on Base (eip155:8453) and the RH settlement asset on Robinhood
 * Chain (eip155:4663), both via EIP-3009 batched settlement through the
 * facilitator. Steer to a rail with OPENZOO_RAIL.
 */
export async function buildEvmPayment({ accept, evmPrivateKey, challenge }) {
  const chainId = evmChainId(accept.network);
  if (!chainId) throw new Error(`cannot parse EVM chain id from network ${accept.network}`);
  const account = privateKeyToAccount(evmPrivateKey);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: accept.payTo,
    value: BigInt(accept.maxAmountRequired), // raw units from the 402 — never decimal-scaled
    validAfter: 0n,
    validBefore: BigInt(now + (accept.maxTimeoutSeconds || 600)),
    nonce: `0x${crypto.randomBytes(32).toString('hex')}`,
  };

  // WHICH TYPED MESSAGE TO SIGN IS THE ROW'S DECISION, NOT OURS.
  //
  // Normal rows are EIP-3009 `TransferWithAuthorization` to the payee. A row
  // marked `extra.settlement === "atomic"` settles through the gateway's
  // AtomicSettle contract, which calls `receiveWithAuthorization` — and that
  // requires msg.sender == to, so the payer must sign
  // **ReceiveWithAuthorization** with `to` = the CONTRACT.
  //
  // The two payloads are IDENTICAL IN SHAPE, so signing the wrong one produces
  // a payment that passes every local check and reverts on chain. The row tells
  // us which it wants in `extra.eip3009`; we honour that and never guess.
  //
  // What the atomic row buys the payer: settlement happens AFTER the work, so
  // the on-chain receipt binds the hash of the response they were served AND
  // the upstream's own COGS transaction — a receipt for the delivery, not just
  // a record of the debit.
  const primaryType = accept.extra?.eip3009 === 'ReceiveWithAuthorization'
    ? 'ReceiveWithAuthorization'
    : 'TransferWithAuthorization';
  const authFields = [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ];

  const signature = await account.signTypedData({
    domain: {
      name: accept.extra?.name || 'USDC',
      version: accept.extra?.version || '2',
      chainId,
      verifyingContract: accept.asset,
    },
    types: { [primaryType]: authFields },
    primaryType,
    message: authorization,
  });

  const payload = {
    signature,
    authorization: {
      ...authorization,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
    },
  };
  return {
    header: encodeEnvelope(paymentEnvelope(challenge, accept, payload)),
    payload,
    ownerSignature: signature,
    from: account.address,
  };
}
