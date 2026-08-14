import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { evmChainId } from './x402.js';

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
 * STATUS: code-present, live-UNTESTED — the zoo's 402s currently offer only
 * Solana rows, and whether its facilitator settles eip155 chains at all is
 * unverified upstream.
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
