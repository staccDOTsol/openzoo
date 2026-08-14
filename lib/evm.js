import crypto from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evmChainId } from './x402.js';

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
 * Standard x402 v1 EVM "exact" scheme: an EIP-3009 transferWithAuthorization
 * typed-data signature; the facilitator submits it. X-PAYMENT = base64 of
 *   { x402Version: 1, scheme: "exact", network: "<as offered>",
 *     payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } }
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
export async function buildEvmPayment({ accept, evmPrivateKey }) {
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

  const signature = await account.signTypedData({
    domain: {
      name: accept.extra?.name || 'USDC',
      version: accept.extra?.version || '2',
      chainId,
      verifyingContract: accept.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });

  const envelope = {
    x402Version: 1,
    scheme: accept.scheme,
    network: accept.network,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  };
  return {
    header: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
    ownerSignature: signature,
    from: account.address,
  };
}
