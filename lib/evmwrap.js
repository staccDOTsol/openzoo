import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evmChainId } from './x402.js';

/**
 * EVM auto-acquire — the Robinhood Chain mirror of wrap.js.
 *
 * The 402's settlement asset on eip155:4663 is an X402Wrapper twin: an
 * ERC-4626-shaped vault + EIP-3009 over the plain token the user actually
 * holds (source + deploy record: /Users/stacc/x402-wrappers, e.g. ODDBALLER /
 * IOU / ROBINHOODS twins, and wUSDGx over USDG). Users hold the PLAIN token;
 * this module converts exactly enough at payment time — approve + deposit —
 * so the wrapper never appears in anything user-facing. Copy in every error
 * names only the unwrapped token.
 *
 * Unlike Solana (where the gateway's feePayer can sponsor the conversion
 * inside the payment tx), the approve+deposit here are the wallet's own
 * transactions: the wallet must hold a sliver of native RH ETH. When it does
 * not, the error says EXACTLY what to send and where.
 */

const WRAPPER_ABI = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'previewMint', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

/** Rough ceiling for approve + deposit on an Arbitrum-Orbit chain. */
const ACQUIRE_GAS_UNITS = 400_000n;

export class NeedsGasError extends Error {
  constructor({ address, shortWei, symbol }) {
    // round the ask up to a friendly margin so one top-up is enough
    const ask = (shortWei * 3n) / 2n;
    super(
      `openzoo: converting your ${symbol} for this payment takes two small on-chain steps, `
      + `and the wallet is short of gas. Send at least ${formatEther(ask)} ETH on Robinhood Chain `
      + `(eip155:4663) to ${address}, then retry.`,
    );
    this.name = 'NeedsGasError';
    this.address = address;
    this.shortWei = shortWei;
  }
}

export class UnderlyingShortError extends Error {
  constructor({ symbol, haveRaw, needRaw, decimals, address }) {
    const ui = (raw) => {
      const d = BigInt(10) ** BigInt(decimals ?? 18);
      return `${raw / d}.${(raw % d).toString().padStart(Number(decimals ?? 18), '0').slice(0, 4)}`;
    };
    super(
      `openzoo wallet underfunded: this call needs ≈${ui(needRaw)} ${symbol} but the wallet `
      + `holds ${ui(haveRaw)} ${symbol} (${address} on Robinhood Chain).`,
    );
    this.name = 'UnderlyingShortError';
    this.symbol = symbol;
    this.haveRaw = haveRaw;
    this.needRaw = needRaw;
  }
}

function chainFor(chainId, rpcUrl) {
  return {
    id: chainId,
    name: `eip155:${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/**
 * Ensure the wallet holds >= `need` raw units of the 402's settlement asset,
 * converting the plain underlying token via approve + deposit when necessary.
 *
 * Resolution order:
 *  - already funded -> { acquired: false }
 *  - not a wrapper (no asset() view) -> { acquired: false, wrapper: false } —
 *    the caller falls back to its plain underfunded message
 *  - wrapper, wallet holds enough underlying + gas -> converts, waits for
 *    receipts, returns { acquired: true, txs: [approveHash?, depositHash] }
 *  - short of underlying -> UnderlyingShortError (names the plain token only)
 *  - short of native gas -> NeedsGasError (says exactly what to send where)
 */
export async function acquireWrappedIfNeeded({ rpcUrl, accept, evmPrivateKey, onStage }) {
  const chainId = evmChainId(accept.network);
  const account = privateKeyToAccount(evmPrivateKey);
  const pc = createPublicClient({ transport: http(rpcUrl) });
  const need = BigInt(accept.maxAmountRequired);

  const bal = await pc.readContract({ address: accept.asset, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [account.address] });
  if (bal >= need) return { acquired: false, wrapper: null };

  let underlying;
  try {
    underlying = await pc.readContract({ address: accept.asset, abi: WRAPPER_ABI, functionName: 'asset', args: [] });
  } catch {
    return { acquired: false, wrapper: false }; // plain token — nothing to convert from
  }

  const short = need - bal;
  // previewMint(short): underlying needed so the vault mints >= short shares
  // (entry fee + rounding included by the contract itself — never re-derived here).
  const assetsNeeded = await pc.readContract({ address: accept.asset, abi: WRAPPER_ABI, functionName: 'previewMint', args: [short] });

  const symbol = await pc
    .readContract({ address: underlying, abi: ERC20_ABI, functionName: 'symbol', args: [] })
    .catch(() => 'underlying token');
  const uBal = await pc.readContract({ address: underlying, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
  if (uBal < assetsNeeded) {
    throw new UnderlyingShortError({
      symbol,
      haveRaw: uBal,
      needRaw: assetsNeeded,
      decimals: accept.extra?.decimals ?? 18,
      address: account.address,
    });
  }

  // Gas preflight — these two txs are the wallet's own, unlike the sponsored
  // Solana path. Fail with the exact shortfall before signing anything.
  const [gasPrice, native] = await Promise.all([pc.getGasPrice(), pc.getBalance({ address: account.address })]);
  const gasBudget = ACQUIRE_GAS_UNITS * gasPrice;
  if (native < gasBudget) {
    throw new NeedsGasError({ address: account.address, shortWei: gasBudget - native, symbol });
  }

  onStage?.('funding');
  const chain = chainFor(chainId, rpcUrl);
  const wc = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const txs = [];

  const allowance = await pc.readContract({
    address: underlying, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, accept.asset],
  });
  if (allowance < assetsNeeded) {
    const approveHash = await wc.writeContract({
      address: underlying, abi: ERC20_ABI, functionName: 'approve', args: [accept.asset, assetsNeeded],
    });
    await pc.waitForTransactionReceipt({ hash: approveHash });
    txs.push(approveHash);
  }

  const depositHash = await wc.writeContract({
    address: accept.asset, abi: WRAPPER_ABI, functionName: 'deposit', args: [assetsNeeded, account.address],
  });
  const receipt = await pc.waitForTransactionReceipt({ hash: depositHash });
  txs.push(depositHash);
  if (receipt.status !== 'success') throw new Error(`openzoo: converting ${symbol} for payment failed on-chain (tx ${depositHash})`);

  const after = await pc.readContract({ address: accept.asset, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [account.address] });
  if (after < need) throw new Error(`openzoo: conversion landed but the balance still cannot cover the quote — retry, or fund more ${symbol}`);
  if (process.env.OPENZOO_DEBUG) console.error(`[openzoo debug] evm acquire txs ${txs.join(', ')}`);
  return { acquired: true, txs };
}
