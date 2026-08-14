import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
const c = new Connection(process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');

for (const d of ['7KPbXPBRucNuA', '4GZMF9CubpdFC', '4GeYMvTLjuguU']) {
  const raw = Buffer.from(bs58.decode(d));
  console.log(d, '-> hex', raw.toString('hex'), 'tag', raw[0], 'amount u64le', raw.length >= 9 ? raw.readBigUInt64LE(1).toString() : '?', 'trailer', raw.length > 9 ? raw[9] : '-');
}

// exact transfer amounts for the three txs
const sigs = [
  '27oQVtfbFiXVB8dR2P62f3ShAXyQJmm7rG7qjcVDNnvGmqHqr7cX4HSdhSuCe5jzFGFBsJeTKCXhHZwzuB3Yx37c',
];
const more = (await c.getSignaturesForAddress(new PublicKey('FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE'), { limit: 12 })).filter((s) => !s.err).map((s) => s.signature);
for (const sig of more.slice(0, 4)) {
  const tx = await c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const xfer = tx.transaction.message.instructions.find((ix) => ix.parsed?.type === 'transferChecked');
  const mint = (tx.meta?.innerInstructions || []).flatMap((x) => x.instructions).find((ix) => ix.parsed?.type === 'mintTo');
  const frse = tx.transaction.message.instructions.find((ix) => ix.programId?.toBase58?.().startsWith('FrSE'));
  const data = frse ? Buffer.from(bs58.decode(frse.data)) : null;
  console.log(sig.slice(0, 10), {
    transferred: xfer?.parsed?.info?.tokenAmount?.amount,
    underlying: xfer?.parsed?.info?.mint?.slice(0, 6),
    dataAmount: data?.readBigUInt64LE(1)?.toString(),
    minted: mint?.parsed?.info?.amount,
  });
}
